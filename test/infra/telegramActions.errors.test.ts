import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Api } from "grammy";

const logApiError = mock((..._args: unknown[]): void => {});
const markSelfSent = mock((..._args: unknown[]): void => {});
const copyMessageApi = mock(async (..._args: unknown[]) => ({ message_id: 91 }));

mock.module("../../packages/infra/telegram/client", () => ({
  bot: { api: { copyMessage: copyMessageApi } },
  logApiError,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent }));

const actions = await import("../../packages/infra/telegram/actions");
const { runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");

function apiWithSuccesses(): Api {
  return {
    sendMessage: mock(async (..._args: unknown[]) => ({ message_id: 11 })),
    sendChatAction: mock(async (..._args: unknown[]) => true),
    answerCallbackQuery: mock(async (..._args: unknown[]) => true),
    sendSticker: mock(async (..._args: unknown[]) => ({ message_id: 12 })),
    sendPhoto: mock(async (..._args: unknown[]) => ({ message_id: 13 })),
    setMessageReaction: mock(async (..._args: unknown[]) => true),
    deleteMessage: mock(async (..._args: unknown[]) => true),
    unbanChatMember: mock(async (..._args: unknown[]) => true),
    banChatMember: mock(async (..._args: unknown[]) => true),
    getChatMember: mock(async (..._args: unknown[]) => ({ status: "creator" })),
    banChatSenderChat: mock(async (..._args: unknown[]) => true),
    unbanChatSenderChat: mock(async (..._args: unknown[]) => true),
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
    sendPhoto: reject,
    setMessageReaction: reject,
    deleteMessage: reject,
    unbanChatMember: reject,
    banChatMember: reject,
    getChatMember: reject,
    banChatSenderChat: reject,
    unbanChatSenderChat: reject,
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
    expect(await actions.sendUploadPhotoAction(-1001, api)).toBe(true);
    expect(await actions.sendChooseStickerAction(-1001, api)).toBe(true);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", text: "done", showAlert: true, api })).resolves.toBeUndefined();
    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBe(12);
    expect(await actions.sendPhoto({ chatId: -1001, bytes: new Uint8Array([1]), mimeType: "image/png", api })).toBe(13);
    expect(await actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).toBe(true);
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(true);
    expect(await actions.kickChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(true);
    expect(await actions.unbanChatMemberIfBanned(-1001, 7, api)).toBe(true);
    expect(await actions.unbanChatSenderChat(-1001, -2002, api)).toBe(true);
    expect(await actions.copyMessage(-1001, -2002, 8)).toBe(91);
    expect(markSelfSent.mock.calls).toEqual([[-1001, 11], [-1001, 12], [-1001, 13], [-1001, 91]]);
    expect(logApiError).not.toHaveBeenCalled();
  });

  test("Telegram 抛错时不向业务层泄漏异常，按动作返回 false/undefined", async () => {
    const api: Api = apiWithFailures();

    expect(await actions.sendMessage({ chatId: -1001, text: "hello", api })).toBeUndefined();
    expect(await actions.sendTypingAction(-1001, api)).toBe(false);
    expect(await actions.sendUploadPhotoAction(-1001, api)).toBe(false);
    expect(await actions.sendChooseStickerAction(-1001, api)).toBe(false);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", api })).resolves.toBeUndefined();
    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBeUndefined();
    expect(await actions.sendPhoto({ chatId: -1001, bytes: new Uint8Array([1]), mimeType: "image/png", api })).toBeUndefined();
    expect(await actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).toBe(false);
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(false);
    expect(await actions.kickChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(false);
    expect(await actions.unbanChatMemberIfBanned(-1001, 7, api)).toBe(false);
    expect(await actions.unbanChatSenderChat(-1001, -2002, api)).toBe(false);

    copyMessageApi.mockRejectedValueOnce(new Error("copy failed"));
    expect(await actions.copyMessage(-1001, -2002, 8)).toBeUndefined();
    expect(logApiError).toHaveBeenCalledTimes(16);
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("主动取消发送时返回 undefined 且不记录 API 错误", async () => {
    const api: Api = apiWithFailures();
    const controller: AbortController = new AbortController();
    controller.abort();

    expect(await actions.sendMessage({
      chatId: -1001,
      text: "hello",
      api,
      signal: controller.signal,
    })).toBeUndefined();
    expect(logApiError).not.toHaveBeenCalled();
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("主动 signal 进入带 other 参数 API 的正确取消槽位", async () => {
    const sendChatAction = mock(async (..._args: unknown[]): Promise<true> => true);
    const setMessageReaction = mock(async (..._args: unknown[]): Promise<true> => true);
    const api: Api = { sendChatAction, setMessageReaction } as unknown as Api;
    const signal: AbortSignal = new AbortController().signal;

    await actions.sendTypingAction(-1001, api, signal);
    await actions.setMessageReaction({
      chatId: -1001,
      messageId: 3,
      emoji: "👍",
      api,
      signal,
    });

    expect(sendChatAction).toHaveBeenCalledWith(-1001, "typing", {}, signal);
    expect(setMessageReaction).toHaveBeenCalledWith(
      -1001,
      3,
      [{ type: "emoji", emoji: "👍" }],
      {},
      signal
    );
  });

  test("停机取消当前 update 时 abort Telegram 请求并向上解开 handler", async () => {
    const controller: AbortController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const sendMessage = mock(
      async (...args: unknown[]): Promise<never> => {
        requestSignal = args[3] as AbortSignal | undefined;
        return await new Promise<never>((_resolve, reject: (reason?: unknown) => void): void => {
          requestSignal?.addEventListener(
            "abort",
            (): void => reject(requestSignal?.reason),
            { once: true }
          );
        });
      }
    );
    const api: Api = { sendMessage } as unknown as Api;

    const sending: Promise<number | undefined> = runWithUpdateAbortSignal(
      controller.signal,
      (): Promise<number | undefined> => actions.sendMessage({
        chatId: -1001,
        text: "hello",
        api,
      })
    );
    await Promise.resolve();
    controller.abort(new DOMException("shutdown", "AbortError"));

    await expect(sending).rejects.toThrow("shutdown");
    expect(requestSignal).toBe(controller.signal);
    expect(logApiError).not.toHaveBeenCalled();
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("成功响应后的映射失败仍按原动作归一化", async () => {
    const api: Api = apiWithSuccesses();
    const mappingError: Error = new Error("self-sent tracking failed");
    markSelfSent.mockImplementationOnce(() => {
      throw mappingError;
    });

    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBeUndefined();
    expect(logApiError).toHaveBeenCalledWith("send sticker", mappingError);
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

describe("解除封禁必须带 only_if_banned", () => {
  test("unbanChatMemberIfBanned 传 only_if_banned，kickChatMember 刻意不传", async () => {
    // Bot API 的 unbanChatMember 对「当前就是群成员」的人语义是把他移出群聊
    // ——kickChatMember 的「只踢不封」正是靠这一点。跨群批量解封若漏了这个
    // 标志，会把本来好端端待在群里的人一个个踢出去。
    const unbanChatMember = mock(async (..._args: unknown[]) => true);
    const api: Api = { unbanChatMember } as unknown as Api;

    await actions.unbanChatMemberIfBanned(-1001, 7, api);
    expect(unbanChatMember).toHaveBeenLastCalledWith(-1001, 7, { only_if_banned: true });

    await actions.kickChatMember(-1001, 7, api);
    expect(unbanChatMember).toHaveBeenLastCalledWith(-1001, 7);
  });
});
