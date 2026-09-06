import { beforeEach, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";
import type { User, UserProfilePhotos } from "grammy/types";
import type { CurrentAvatar } from "../../packages/types/telegram";
import { runWithUpdateAbortSignal } from "../../packages/infra/updateContext";

type ApiMock = Mock<(...args: any[]) => Promise<any>>;
const getChat: ApiMock = mock(async (): Promise<any> => ({ photo: { big_file_id: "active-photo", big_file_unique_id: "active-unique" } }));
const getUserProfilePhotos: ApiMock = mock(async (): Promise<UserProfilePhotos> => ({ total_count: 0, photos: [] }));
const download: ApiMock = mock(async (): Promise<any> => ({ status: "ok", bytes: new Uint8Array([1, 2, 3]) }));
const web: ApiMock = mock(async (): Promise<Uint8Array> => new Uint8Array([4, 5]));
const logError: Mock<(...args: unknown[]) => void> = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({ logger: { error: logError, warn(): void {}, info(): void {}, log(): void {} } }));
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { getChat, getUserProfilePhotos } } }));
mock.module("../../packages/infra/telegram/avatar/download", () => ({ downloadAvatarFile: download }));
mock.module("../../packages/infra/telegram/avatar/webProfile", () => ({ fetchAvatarFromWebProfile: web }));
const { readCurrentAvatar } = await import("../../packages/infra/telegram/avatar/read");
const user: User = { id: 42, first_name: "群友", username: "current_user", is_bot: false };

function currentPhotos(): UserProfilePhotos {
  return { total_count: 3, photos: [
    [],
    [{ file_id: "history", file_unique_id: "history-unique", width: 640, height: 640 }],
    [{ file_id: "small", file_unique_id: "small-unique", width: 160, height: 160 },
      { file_id: "reusable-current", file_unique_id: "active-unique", width: 640, height: 640 },
      { file_id: "larger", file_unique_id: "larger-unique", width: 1280, height: 1280 }],
  ] };
}

beforeEach((): void => {
  for (const fn of [getChat, getUserProfilePhotos, download, web, logError]) fn.mockClear();
  getChat.mockImplementation(async (): Promise<any> => ({ photo: { big_file_id: "active-photo", big_file_unique_id: "active-unique" } }));
  getUserProfilePhotos.mockImplementation(async (): Promise<UserProfilePhotos> => ({ total_count: 0, photos: [] }));
  download.mockImplementation(async (): Promise<any> => ({ status: "ok", bytes: new Uint8Array([1, 2, 3]) }));
});

test("历史列表匹配当前头像，直接返回可复用 file_id，不下载或猜测首张历史", async (): Promise<void> => {
  const signal: AbortSignal = new AbortController().signal;
  getUserProfilePhotos.mockImplementationOnce(async (): Promise<UserProfilePhotos> => currentPhotos());
  expect(await readCurrentAvatar(user, signal)).toEqual({ identity: user, photo: "reusable-current" });
  expect(getUserProfilePhotos).toHaveBeenCalledWith(42, { offset: 0, limit: 100 }, signal);
  expect(download).not.toHaveBeenCalled();
  expect(web).not.toHaveBeenCalled();
});

test("无可复用头像时下载当前 ChatPhoto，不把只供下载的 file_id 当成可发送图片", async (): Promise<void> => {
  const signal: AbortSignal = new AbortController().signal;
  expect(await readCurrentAvatar(user, signal)).toEqual({ identity: user, photo: new Uint8Array([1, 2, 3]) });
  expect(download).toHaveBeenCalledWith("active-photo", 42, signal);
  expect(web).not.toHaveBeenCalled();
});

test("用户未与 bot 私聊时使用本轮核实的 username，复用公开头像抓取", async (): Promise<void> => {
  getChat.mockImplementationOnce(async (): Promise<any> => { throw new Error("chat inaccessible"); });
  const signal: AbortSignal = new AbortController().signal;
  expect(await readCurrentAvatar(user, signal)).toEqual({ identity: user, photo: new Uint8Array([4, 5]) });
  expect(getUserProfilePhotos).not.toHaveBeenCalled();
  expect(web).toHaveBeenCalledWith("current_user", signal);
});

test("无当前头像且无公开用户名不猜测历史头像；取消不再触发网页请求", async (): Promise<void> => {
  getChat.mockImplementation(async (): Promise<any> => ({}));
  expect(await readCurrentAvatar({ id: 42, first_name: "群友", is_bot: false }, new AbortController().signal)).toBeUndefined();
  const controller: AbortController = new AbortController();
  controller.abort();
  expect(await readCurrentAvatar(user, controller.signal)).toBeUndefined();
  expect(web).not.toHaveBeenCalled();
  expect(getUserProfilePhotos).not.toHaveBeenCalled();
});

test("下载失败时可以继续读取已核实用户的公开头像", async (): Promise<void> => {
  download.mockImplementationOnce(async (): Promise<any> => ({ status: "permanent-failure" }));
  expect(await readCurrentAvatar(user, new AbortController().signal)).toEqual({ identity: user, photo: new Uint8Array([4, 5]) });
});

test("频道使用 getChat 的当前身份与头像；下载失败仅访问当前公开用户名", async (): Promise<void> => {
  const channel = { id: -10042, type: "channel", title: "当前频道", username: "current_channel", photo: { big_file_id: "channel-photo" } } as const;
  getChat.mockImplementation(async (): Promise<any> => channel);
  const signal: AbortSignal = new AbortController().signal;
  expect(await readCurrentAvatar(channel.id, signal)).toEqual({ identity: channel, photo: new Uint8Array([1, 2, 3]) });
  expect(getChat).toHaveBeenCalledTimes(1);
  expect(getChat).toHaveBeenCalledWith(channel.id, signal);
  expect(download).toHaveBeenCalledWith("channel-photo", channel.id, signal);
  download.mockImplementationOnce(async (): Promise<any> => ({ status: "permanent-failure" }));
  expect(await readCurrentAvatar(channel.id, signal)).toEqual({ identity: channel, photo: new Uint8Array([4, 5]) });
  expect(web).toHaveBeenCalledWith("current_channel", signal);
  expect(getUserProfilePhotos).not.toHaveBeenCalled();
});

test("频道身份查询失败或返回不符时不猜测用户名，也不下载其它身份的图片", async (): Promise<void> => {
  const signal: AbortSignal = new AbortController().signal;
  getChat.mockImplementationOnce(async (): Promise<any> => { throw new Error("chat inaccessible"); });
  expect(await readCurrentAvatar(-10042, signal)).toBeUndefined();
  getChat.mockImplementationOnce(async (): Promise<any> => ({ id: -10042, type: "supergroup", username: "old_name" }));
  expect(await readCurrentAvatar(-10042, signal)).toBeUndefined();
  getChat.mockImplementationOnce(async (): Promise<any> => ({ id: -9999, type: "channel", username: "another" }));
  expect(await readCurrentAvatar(-10042, signal)).toBeUndefined();
  expect(web).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

test("历史头像未匹配当前身份时只下载当前头像", async (): Promise<void> => {
  getUserProfilePhotos.mockImplementationOnce(async (): Promise<UserProfilePhotos> => ({
    total_count: 1, photos: [[{ file_id: "old", file_unique_id: "old-unique", width: 640, height: 640 }]],
  }));
  expect((await readCurrentAvatar(user, new AbortController().signal))?.photo).toEqual(new Uint8Array([1, 2, 3]));
  expect(download).toHaveBeenCalledTimes(1);
  expect(web).not.toHaveBeenCalled();
});

test("用户头像查询失败只记录一次并保留当前头像下载路径", async (): Promise<void> => {
  getUserProfilePhotos.mockImplementationOnce(async (): Promise<never> => { throw new Error("fixture query failed"); });
  expect((await readCurrentAvatar(user, new AbortController().signal))?.photo).toEqual(new Uint8Array([1, 2, 3]));
  expect(download).toHaveBeenCalledTimes(1);
  expect(web).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledTimes(1);
});

test("预取消不发起任何头像查询", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  controller.abort();
  expect(await readCurrentAvatar(user, controller.signal)).toBeUndefined();
  expect(getChat).not.toHaveBeenCalled();
  expect(getUserProfilePhotos).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(web).not.toHaveBeenCalled();
});

for (const stage of ["chat", "photos"] as const) {
  test(`${stage} 查询期间取消，不消费迟到头像或进入下载兜底`, async (): Promise<void> => {
    const controller: AbortController = new AbortController();
    const pending: PromiseWithResolvers<any> = Promise.withResolvers<any>();
    const started: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const query: ApiMock = stage === "chat" ? getChat : getUserProfilePhotos;
    query.mockImplementationOnce((): Promise<any> => { started.resolve(); return pending.promise; });
    const task: Promise<CurrentAvatar | undefined> = readCurrentAvatar(user, controller.signal);
    await started.promise;
    controller.abort();
    pending.resolve(stage === "chat"
      ? { photo: { big_file_id: "active-photo", big_file_unique_id: "active-unique" } }
      : currentPhotos());
    expect(await task).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    if (stage === "chat") expect(getUserProfilePhotos).not.toHaveBeenCalled();
  });
}

test("update 在头像查询期间取消时继续传播取消，不降级为下载", async (): Promise<void> => {
  const controller: AbortController = new AbortController();
  const pending: PromiseWithResolvers<UserProfilePhotos> = Promise.withResolvers<UserProfilePhotos>();
  const started: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  getUserProfilePhotos.mockImplementationOnce((): Promise<UserProfilePhotos> => { started.resolve(); return pending.promise; });
  const task: Promise<CurrentAvatar | undefined> = runWithUpdateAbortSignal(controller.signal,
    (): Promise<CurrentAvatar | undefined> => readCurrentAvatar(user, new AbortController().signal));
  const outcome: Promise<unknown> = task.catch((error: unknown): unknown => error);
  await started.promise;
  controller.abort();
  pending.resolve(currentPhotos());
  expect(await outcome).toBe(controller.signal.reason);
  expect(download).not.toHaveBeenCalled();
  expect(web).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
});
