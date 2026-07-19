import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Api } from "grammy";

const logApiError = mock((..._args: unknown[]): void => {});
const markSelfSent = mock((..._args: unknown[]): void => {});
const copyMessageApi = mock(async (..._args: unknown[]) => ({ message_id: 91 }));

mock.module("../../src/infra/telegram/client", () => ({
  bot: { api: { copyMessage: copyMessageApi } },
  logApiError,
}));
mock.module("../../src/infra/selfSentTracker", () => ({ markSelfSent }));

const actions = await import("../../src/infra/telegram/actions");

function apiWithSuccesses(): Api {
  return {
    sendMessage: mock(async (..._args: unknown[]) => ({ message_id: 11 })),
    sendChatAction: mock(async (..._args: unknown[]) => true),
    answerCallbackQuery: mock(async (..._args: unknown[]) => true),
    sendSticker: mock(async (..._args: unknown[]) => ({ message_id: 12 })),
    setMessageReaction: mock(async (..._args: unknown[]) => true),
    deleteMessage: mock(async (..._args: unknown[]) => true),
    unbanChatMember: mock(async (..._args: unknown[]) => true),
    banChatMember: mock(async (..._args: unknown[]) => true),
    getChatMember: mock(async (..._args: unknown[]) => ({ status: "creator" })),
    banChatSenderChat: mock(async (..._args: unknown[]) => true),
  } as unknown as Api;
}

function apiWithFailures(): Api {
  const reject = mock(async (..._args: unknown[]): Promise<never> => {
    throw new Error("telegram unavailable");
  });
  return {
    sendMessage: reject,
    sendChatAction: reject,
    answerCallbackQuery: reject,
    sendSticker: reject,
    setMessageReaction: reject,
    deleteMessage: reject,
    unbanChatMember: reject,
    banChatMember: reject,
    getChatMember: reject,
    banChatSenderChat: reject,
  } as unknown as Api;
}

beforeEach(() => {
  logApiError.mockClear();
  markSelfSent.mockClear();
  copyMessageApi.mockClear();
  copyMessageApi.mockImplementation(async () => ({ message_id: 91 }));
});

describe("Telegram 动作适配层失败归一化", () => {
  test("所有成功动作返回稳定值，并登记机器人自发消息", async () => {
    const api: Api = apiWithSuccesses();
    const keyboard = { inline_keyboard: [[{ text: "确认", callback_data: "ok" }]] };

    expect(await actions.sendMessage({ chatId: -1001, text: "hello", api, keyboard: keyboard as never })).toBe(11);
    expect(await actions.sendTypingAction(-1001, api)).toBe(true);
    expect(await actions.sendChooseStickerAction(-1001, api)).toBe(true);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", text: "done", showAlert: true, api })).resolves.toBeUndefined();
    expect(await actions.sendSticker(-1001, "file", api)).toBe(12);
    await expect(actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).resolves.toBeUndefined();
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(true);
    expect(await actions.kickChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(true);
    expect(await actions.copyMessage(-1001, -2002, 8)).toBe(91);
    expect(markSelfSent.mock.calls).toEqual([[-1001, 11], [-1001, 12], [-1001, 91]]);
    expect(logApiError).not.toHaveBeenCalled();
  });

  test("Telegram 抛错时不向业务层泄漏异常，按动作返回 false/undefined", async () => {
    const api: Api = apiWithFailures();

    expect(await actions.sendMessage({ chatId: -1001, text: "hello", api })).toBeUndefined();
    expect(await actions.sendTypingAction(-1001, api)).toBe(false);
    expect(await actions.sendChooseStickerAction(-1001, api)).toBe(false);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", api })).resolves.toBeUndefined();
    expect(await actions.sendSticker(-1001, "file", api)).toBeUndefined();
    await expect(actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).resolves.toBeUndefined();
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(false);
    expect(await actions.kickChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(false);

    copyMessageApi.mockRejectedValueOnce(new Error("copy failed"));
    expect(await actions.copyMessage(-1001, -2002, 8)).toBeUndefined();
    expect(logApiError).toHaveBeenCalledTimes(12);
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("延迟删除只注册一个不阻止退出的 timer，并在到期后复用 deleteMessage", async () => {
    const api: Api = apiWithSuccesses();
    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    let scheduled: (() => void) | null = null;
    const unref = mock((): void => {});
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay: number) => {
      expect(delay).toBe(500);
      scheduled = callback;
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      actions.deleteMessageAfter({ chatId: -1001, messageId: 44, delayMs: 500, api });
      expect(unref).toHaveBeenCalledTimes(1);
      scheduled!();
      await Promise.resolve();
      expect(api.deleteMessage).toHaveBeenCalledWith(-1001, 44);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
