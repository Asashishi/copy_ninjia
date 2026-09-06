import { expect, mock, test } from "bun:test";
import { Api } from "grammy";
import type { PhotoSize, User } from "grammy/types";
import type * as AvatarReader from "../../packages/infra/telegram/avatar/read";
import type * as WedMessages from "../../packages/commands/wed/messages";
import { WED_MAX_CONCURRENT } from "../../packages/consts/wed";
import type { CurrentAvatar } from "../../packages/types/telegram";
import type { WedCandidate, WedSession } from "../../packages/types/wed";

interface RecordedRequest {
  readonly method: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const requests: RecordedRequest[] = [];
const current: Readonly<PhotoSize> = {
  file_id: "fixture-reusable-avatar", file_unique_id: "fixture-active-avatar", width: 640, height: 640,
};
const user: User = { id: 42, first_name: "fixture", is_bot: false };
const api: Api = new Api("123:fixture", {
  fetch: async (url: unknown, init?: Readonly<{ body?: unknown }>): Promise<Response> => {
    if (typeof init?.body !== "string") throw new Error("Unexpected multipart upload");
    const method: string = String(url).split("/").at(-1)!;
    const body: Record<string, unknown> = JSON.parse(init.body);
    requests.push({ method, body });
    switch (method) {
      case "getChat":
        return Response.json({ ok: true, result: { id: 42, type: "private", first_name: "fixture", photo: {
          big_file_id: "fixture-download-only", big_file_unique_id: current.file_unique_id,
        } } });
      case "getUserProfilePhotos":
        return Response.json({ ok: true, result: { total_count: 1, photos: [[current]] } });
      case "sendPhoto":
      case "editMessageMedia":
        return Response.json({ ok: true, result: { message_id: 100, date: 1, chat: {
          id: -100, type: "supergroup", title: "fixture",
        }, photo: [current] } });
      default:
        throw new Error(`Unexpected API method: ${method}`);
    }
  },
});

mock.module("../../packages/infra/logger", (): unknown => ({ logger: { error(): void {} } }));
mock.module("../../packages/infra/telegram/mainClient", (): unknown => ({ bot: { api } }));
mock.module("../../packages/infra/telegram/avatar/download", (): unknown => ({
  downloadAvatarFile: async (): Promise<never> => { throw new Error("Unexpected avatar download"); },
}));
mock.module("../../packages/infra/telegram/avatar/webProfile", (): unknown => ({
  fetchAvatarFromWebProfile: async (): Promise<never> => { throw new Error("Unexpected profile scrape"); },
}));
mock.module("../../packages/infra/telegram", (): unknown => ({
  deleteMessageWithOutcome: async (): Promise<never> => { throw new Error("Unexpected photo deletion"); },
}));

const { readCurrentAvatar }: typeof AvatarReader =
  await import("../../packages/infra/telegram/avatar/read");
const { sendWedResult, replaceWedResult }: typeof WedMessages =
  await import("../../packages/commands/wed/messages");

test("真实头像读取与 grammY 出站在并发上限内只传 JSON，不下载或上传图片", async (): Promise<void> => {
  const tasks: Promise<void>[] = [];
  for (let index: number = 0; index < WED_MAX_CONCURRENT; index++) {
    tasks.push((async (): Promise<void> => {
      const session: WedSession = {
        chatId: -100, actor: { ...user, id: index + 1 }, messageThreadId: 77,
        controller: new AbortController(), messageId: undefined, targetId: undefined,
        confirmed: false, busy: true,
      };
      const avatar: CurrentAvatar | undefined = await readCurrentAvatar(user, session.controller.signal);
      if (avatar === undefined) throw new Error("Missing current avatar");
      expect(avatar.photo).toBe(current.file_id);
      const candidate: WedCandidate = { identity: user, photo: avatar.photo };
      expect(await sendWedResult({ session, candidate, replyToMessageId: 50, signal: session.controller.signal })).toBeTrue();
      expect(session.messageId).toBe(100);
      expect(session.targetId).toBe(user.id);
      expect(await replaceWedResult(session, candidate, session.controller.signal)).toBeTrue();
    })());
  }
  const settled: PromiseSettledResult<void>[] = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
  expect(requests).toHaveLength(WED_MAX_CONCURRENT * 4);
  let sent: number = 0;
  let replaced: number = 0;
  for (const request of requests) {
    if (request.method === "sendPhoto") {
      sent++;
      expect(request.body.photo).toBe(current.file_id);
      expect(request.body.message_thread_id).toBe(77);
      expect(request.body.reply_parameters).toEqual({ message_id: 50, allow_sending_without_reply: true });
    } else if (request.method === "editMessageMedia") {
      replaced++;
      expect(request.body.media).toMatchObject({ type: "photo", media: current.file_id });
    }
  }
  expect(sent).toBe(WED_MAX_CONCURRENT);
  expect(replaced).toBe(WED_MAX_CONCURRENT);
});
