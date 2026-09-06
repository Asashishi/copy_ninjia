import { resetWedMemberStates } from "../../packages/cache/main/wedMembers";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { Bot } from "grammy";
import type { User } from "grammy/types";
import { runAcknowledgedUpdateBatches } from "../../packages/app/updateRunner";
import { wedChats, wedRuntime } from "../../packages/cache/main/wed";
import { currentUpdateAbortSignal, runWithUpdateAbortSignal } from "../../packages/infra/updateContext";

const logError = mock((): void => {});
mock.module("../../packages/infra/logger", () => ({ logger: { error: logError, warn(): void {}, info(): void {}, log(): void {} } }));
let download = Promise.withResolvers<void>();
let upload = Promise.withResolvers<void>();
const partner: User = { id: 999, is_bot: false, first_name: "群友" };
const avatar = mock(async () => {
  await download.promise;
  return { identity: partner, photo: "current-avatar" };
});
mock.module("../../packages/infra/telegram/avatar/read", () => ({ readCurrentAvatar: avatar }));

const { bot } = await import("../../packages/infra/telegram/mainClient");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");
const { resetPendingMessageDeletions } = await import("../../packages/infra/telegram");
const { getOrCreateWedChat } = await import("../../packages/commands/wed/chats");
const { handleWedCommand, teardownWedInChat } = await import("../../packages/commands/wed");
const { dispatchWedCallback, dispatchWedCommand } = await import("../../packages/commands/wed/dispatch");
const { drainWedRuntime, initWedRuntime, submitWedTask } = await import("../../packages/commands/wed/runtime");
const { WED_CHAT_CACHE_MAX_ENTRIES, WED_TEXTS, WED_MAX_CONCURRENT } = await import("../../packages/consts/wed");
const chat = { id: -1001, type: "supergroup", title: "群" } as const;
let nextMessageId: number = 100;
const photo = mock(async (..._args: any[]): Promise<any> => {
  await upload.promise;
  return { message_id: ++nextMessageId, chat, date: 1, photo: [] };
});
const answer = mock(async (..._args: any[]) => true);
const edit = mock(async (..._args: any[]) => true);
const remove = mock(async (..._args: any[]) => true);

function command(id: number): never {
  const from: User = { id, is_bot: false, first_name: `发起人${id}` };
  const msg = { message_id: id, chat, from, text: "/wed" };
  return { chat, msg, from, msgId: id, match: "" } as never;
}

function fillWedChatCache(): void {
  for (let id = 1; id < WED_CHAT_CACHE_MAX_ENTRIES; id++) {
    wedChats.set(-10_000 - id, { controller: new AbortController(), members: new Set(), sessions: new Map() });
  }
}

beforeEach(() => {
  initWedRuntime();
  getOrCreateWedChat(chat.id)!.members.add(partner.id);
  download = Promise.withResolvers<void>();
  upload = Promise.withResolvers<void>();
  nextMessageId = 100;
  for (const fn of [avatar, photo, answer, edit, remove, logError]) fn.mockClear();
  Object.assign(bot.api, {
    getChatMember: async () => ({ status: "member", user: partner }),
    sendPhoto: photo, answerCallbackQuery: answer, editMessageMedia: edit, deleteMessage: remove,
    sendMessage: async () => ({ message_id: ++nextMessageId, chat, date: 1 }),
  });
  telegramApiState.current = bot.api as never;
});

afterEach(async () => {
  await drainWedRuntime(0);
  download.resolve();
  upload.resolve();
  await Promise.allSettled(wedRuntime.current!.tasks);
  resetPendingMessageDeletions();
  wedChats.clear();
  resetWedMemberStates();
});

test("频道命令不创建群缓存或进入交互执行器", async () => {
  wedChats.clear();
  resetWedMemberStates();
  const from: User = { id: 1, is_bot: false, first_name: "占位用户" };
  const msg = { message_id: 1, chat, from, sender_chat: { id: -2002, type: "channel", title: "频道" } };
  await dispatchWedCommand({ chat, msg, from, msgId: 1, match: "" } as never);
  expect(wedChats.size).toBe(0);
  expect(wedRuntime.current!.tasks.size).toBe(0);
  expect(avatar).not.toHaveBeenCalled();
  expect(photo).not.toHaveBeenCalled();
});

test("真实 update runner 超过 /wed 并发上限后仍处理普通更新，查询和发图期间持续占槽", async () => {
  let nextUpdateId: number = 1;
  const observedOther = Promise.withResolvers<void>();
  const fetchOffsets: number[] = [];
  const fakeBot = {
    api: { getUpdates: async (args: { offset: number }) => {
      fetchOffsets.push(args.offset);
      return [{ update_id: nextUpdateId++ }];
    } },
    handleUpdate: async ({ update_id }: { update_id: number }) => {
      if (update_id <= WED_MAX_CONCURRENT + 2) await dispatchWedCommand(command(update_id));
      else {
        observedOther.resolve();
        void runner.stop();
      }
    },
    errorHandler: (error: unknown) => { throw error; },
  };
  const runner = runAcknowledgedUpdateBatches(fakeBot as unknown as Bot, ["message"]);
  try {
    await observedOther.promise;
    expect(fetchOffsets.at(-1)).toBe(WED_MAX_CONCURRENT + 3);
    expect(avatar).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
    expect(photo).not.toHaveBeenCalled();
    expect(wedRuntime.current!.runner.activeCount).toBe(WED_MAX_CONCURRENT);
    expect(wedRuntime.current!.runner.pendingCount).toBe(2);
    download.resolve();
    await Bun.sleep(0);
    expect(photo).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
    expect(avatar).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
    expect(wedRuntime.current!.runner.pendingCount).toBe(2);
    upload.resolve();
    expect(await drainWedRuntime(1_000)).toBe("flushed");
    expect(photo).toHaveBeenCalledTimes(WED_MAX_CONCURRENT + 2);
    expect(wedChats.get(chat.id)!.sessions.size).toBe(WED_MAX_CONCURRENT + 2);
  } finally {
    await runner.stop();
  }
});

test("群 teardown 取消在途交互与等待命令，迟到头像不能发图或重建已关闭群", async () => {
  for (let id = 1; id <= WED_MAX_CONCURRENT + 2; id++) dispatchWedCommand(command(id));
  await Bun.sleep(0);
  expect(avatar).toHaveBeenCalledTimes(WED_MAX_CONCURRENT);
  expect(wedRuntime.current!.runner.pendingCount).toBe(2);
  await teardownWedInChat(chat.id);
  expect(wedRuntime.current!.runner.pendingCount).toBe(0);
  download.resolve();
  upload.resolve();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(photo).not.toHaveBeenCalled();
  expect(wedChats.has(chat.id)).toBeFalse();
});

test("排队按钮出队后重验目标，不把旧按钮应用到已更新结果", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  const state = wedChats.get(chat.id)!;
  const session = state.sessions.get(1)!;
  const held = Promise.withResolvers<void>();
  try {
    for (let id = 0; id < WED_MAX_CONCURRENT; id++) submitWedTask(state, () => held.promise);
    expect(dispatchWedCallback({ callbackQuery: {
      id: "old-button", data: "wed:1:999:change", from: { id: 1 },
      message: { message_id: session.messageId, chat, date: 1 },
    } } as never)).toBe(true);
    session.targetId = 1000;
    held.resolve();
    expect(await drainWedRuntime(1_000)).toBe("flushed");
    expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.updated);
    expect(edit).not.toHaveBeenCalled();
    expect(avatar).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve();
  }
});

test("达到停机预算时取消真实交互的出站上下文，新命令不再进入执行器", async () => {
  let observed: AbortSignal | undefined;
  avatar.mockImplementationOnce(async () => {
    observed = currentUpdateAbortSignal();
    await download.promise;
    return { identity: partner, photo: "current-avatar" };
  });
  dispatchWedCommand(command(1));
  await Bun.sleep(0);
  expect(observed?.aborted).toBeFalse();
  expect(await drainWedRuntime(0)).toBe("timedOut");
  expect(observed?.aborted).toBeTrue();
  dispatchWedCommand(command(2));
  download.resolve();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(photo).not.toHaveBeenCalled();
  expect(avatar).toHaveBeenCalledTimes(1);
});

test("LRU 淘汰取消等待与在途查询，迟到头像不发图也不重建旧群", async () => {
  const state = wedChats.get(chat.id)!;
  for (let id = 1; id <= WED_MAX_CONCURRENT + 2; id++) dispatchWedCommand(command(id));
  await Bun.sleep(0);
  expect(wedRuntime.current!.runner.pendingCount).toBe(2);
  fillWedChatCache();
  expect(getOrCreateWedChat(-2002)).toBeDefined();
  expect(wedChats.has(chat.id)).toBeFalse();
  expect(state.controller.signal.aborted).toBeTrue();
  expect(wedRuntime.current!.runner.pendingCount).toBe(0);
  for (const session of state.sessions.values()) expect(session.controller.signal.aborted).toBeTrue();
  download.resolve();
  upload.resolve();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(photo).not.toHaveBeenCalled();
  expect(wedChats.has(chat.id)).toBeFalse();
});

test("LRU 淘汰时迟到的上传结果由原会话删除，不影响同群的新交互", async () => {
  download.resolve();
  dispatchWedCommand(command(1));
  await Bun.sleep(0);
  expect(photo).toHaveBeenCalledTimes(1);
  const previous = wedChats.get(chat.id)!;
  fillWedChatCache();
  getOrCreateWedChat(-2002);
  const renewed = getOrCreateWedChat(chat.id)!;
  expect(renewed).not.toBe(previous);
  expect(renewed.members).toBe(previous.members);
  upload.resolve();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove.mock.calls[0]!.slice(0, 2)).toEqual([chat.id, 101]);
  expect(wedChats.peek(chat.id)).toBe(renewed);
  expect(renewed.controller.signal.aborted).toBeFalse();
  expect(renewed.sessions.size).toBe(0);
});

test("LRU 淘汰的空闲结果删除纳入停机排空，旧按钮失效", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  const state = wedChats.get(chat.id)!;
  const messageId = state.sessions.get(1)!.messageId;
  const deletion = Promise.withResolvers<void>();
  remove.mockImplementationOnce(async () => { await deletion.promise; return true; });
  try {
    fillWedChatCache();
    getOrCreateWedChat(-2002);
    expect(wedChats.has(chat.id)).toBeFalse();
    expect(wedRuntime.current!.tasks.size).toBe(1);
    await dispatchWedCallback({ callbackQuery: {
      id: "evicted-button", data: "wed:1:999:change", from: { id: 1 },
      message: { message_id: messageId, chat, date: 1 },
    } } as never);
    expect(answer.mock.calls.at(-1)![1].text).toBe(WED_TEXTS.expired);
    let drained = false;
    const draining = drainWedRuntime(1_000).then((result) => { drained = true; return result; });
    await Bun.sleep(0);
    expect(drained).toBeFalse();
    deletion.resolve();
    expect(await draining).toBe("flushed");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(state.sessions.get(1)!.messageId).toBeUndefined();
  } finally {
    deletion.resolve();
  }
});

test("按钮访问刷新群 LRU，扩容淘汰下一个最旧群", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  const messageId = wedChats.get(chat.id)!.sessions.get(1)!.messageId;
  fillWedChatCache();
  await dispatchWedCallback({ callbackQuery: {
    id: "recent-button", data: "wed:1:999:change", from: { id: 1 },
    message: { message_id: messageId, chat, date: 1 },
  } } as never);
  getOrCreateWedChat(-2002);
  expect(wedChats.has(chat.id)).toBeTrue();
  expect(wedChats.has(-10_001)).toBeFalse();
  expect(await drainWedRuntime(1_000)).toBe("flushed");
});

test("触发淘汰的 update 取消不终止旧群清理，删除使用运行时的取消边界", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  await handleWedCommand(command(2));
  const deletion = Promise.withResolvers<void>();
  remove.mockImplementationOnce(async () => { await deletion.promise; return true; });
  const updateController = new AbortController();
  try {
    fillWedChatCache();
    await runWithUpdateAbortSignal(updateController.signal, async () => {
      getOrCreateWedChat(-2002);
    });
    updateController.abort();
    expect(remove.mock.calls[0]![2]).toBe(wedRuntime.current!.controller.signal);
    expect(wedRuntime.current!.controller.signal.aborted).toBeFalse();
    deletion.resolve();
    expect(await drainWedRuntime(1_000)).toBe("flushed");
    expect(remove.mock.calls.map((args) => args.slice(0, 2))).toEqual([[chat.id, 101], [chat.id, 102]]);
    expect(logError).not.toHaveBeenCalled();
  } finally {
    deletion.resolve();
  }
});

test("淘汰清理中单条删除失败仍清理其余结果，失败走统一日志且不恢复旧群", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  await handleWedCommand(command(2));
  remove.mockImplementationOnce(async () => { throw new Error("expected deletion failure"); });
  fillWedChatCache();
  getOrCreateWedChat(-2002);
  expect(await drainWedRuntime(1_000)).toBe("flushed");
  expect(remove.mock.calls.map((args) => args.slice(0, 2))).toEqual([[chat.id, 101], [chat.id, 102]]);
  expect(logError).toHaveBeenCalledTimes(1);
  expect(wedChats.has(chat.id)).toBeFalse();
});

test("淘汰清理等待空闲结果时忙碌会话自行结束，不会重复删除忙碌结果", async () => {
  download.resolve();
  upload.resolve();
  await handleWedCommand(command(1));
  upload = Promise.withResolvers<void>();
  dispatchWedCommand(command(2));
  await Bun.sleep(0);
  const deletion = Promise.withResolvers<void>();
  const busyDeleted = Promise.withResolvers<void>();
  remove.mockImplementationOnce(async () => { await deletion.promise; return true; });
  remove.mockImplementationOnce(async () => { busyDeleted.resolve(); return true; });
  try {
    fillWedChatCache();
    getOrCreateWedChat(-2002);
    upload.resolve();
    await busyDeleted.promise;
    await Bun.sleep(0);
    deletion.resolve();
    expect(await drainWedRuntime(1_000)).toBe("flushed");
    expect(remove.mock.calls.map((args) => args.slice(0, 2))).toEqual([[chat.id, 101], [chat.id, 102]]);
  } finally {
    deletion.resolve();
    upload.resolve();
  }
});
