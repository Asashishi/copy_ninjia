import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";
import type { Api } from "grammy";
import type { TelegramApi } from "../../packages/types/telegramWorker";
import { settleTestBatch } from "../libs/helpers";

const logApiError = mock((..._args: unknown[]): void => {});
const markSelfSent = mock((..._args: unknown[]): void => {});
const copyMessageApi = mock(async (..._args: unknown[]) => ({ message_id: 91 }));
const telegramApi = { copyMessage: copyMessageApi };

mock.module("../../packages/infra/telegram/client", () => ({
  bot: { api: telegramApi },
  telegramApi,
  logApiError,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ markSelfSent }));

const actions = await import("../../packages/infra/telegram/actions");
const { runWithUpdateAbortSignal } = await import("../../packages/infra/updateContext");

function apiWithSuccesses(): TelegramApi {
  return {
    sendMessage: mock(async (..._args: unknown[]) => ({ message_id: 11 })),
    sendChatAction: mock(async (..._args: unknown[]) => true),
    answerCallbackQuery: mock(async (..._args: unknown[]) => true),
    sendSticker: mock(async (..._args: unknown[]) => ({ message_id: 12 })),
    sendPhoto: mock(async (..._args: unknown[]) => ({ message_id: 13 })),
    setMessageReaction: mock(async (..._args: unknown[]) => true),
    deleteMessage: mock(async (..._args: unknown[]) => true),
    deleteMessages: mock(async (..._args: unknown[]) => true),
    unbanChatMember: mock(async (..._args: unknown[]) => true),
    banChatMember: mock(async (..._args: unknown[]) => true),
    getChatMember: mock(async (..._args: unknown[]) => ({ status: "creator" })),
    banChatSenderChat: mock(async (..._args: unknown[]) => true),
    unbanChatSenderChat: mock(async (..._args: unknown[]) => true),
  } as unknown as TelegramApi;
}

function apiWithFailures(): TelegramApi {
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
    deleteMessages: reject,
    unbanChatMember: reject,
    banChatMember: reject,
    getChatMember: reject,
    banChatSenderChat: reject,
    unbanChatSenderChat: reject,
  } as unknown as TelegramApi;
}

beforeEach(() => {
  actions.resetPendingMessageDeletions();
  logApiError.mockClear();
  markSelfSent.mockClear();
  copyMessageApi.mockClear();
  copyMessageApi.mockImplementation(async () => ({ message_id: 91 }));
});

describe("Telegram 动作适配层失败归一化", () => {
  test("所有成功动作返回稳定值，并登记机器人自发消息", async () => {
    const api: TelegramApi = apiWithSuccesses();
    const keyboard = { inline_keyboard: [[{ text: "确认", callback_data: "ok" }]] };

    expect(await actions.sendMessage({ chatId: -1001, text: "hello", api, keyboard: keyboard as never })).toBe(11);
    expect(await actions.sendChatAction({ chatId: -1001, action: "typing", api })).toBe(true);
    expect(await actions.sendChatAction({ chatId: -1001, action: "upload_photo", api })).toBe(true);
    expect(await actions.sendChatAction({ chatId: -1001, action: "choose_sticker", api })).toBe(true);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", text: "done", showAlert: true, api })).resolves.toBeUndefined();
    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBe(12);
    expect(await actions.sendPhoto({ chatId: -1001, bytes: new Uint8Array([1]), mimeType: "image/png", api })).toBe(13);
    expect(await actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).toBe(true);
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(true);
    expect(await actions.kickChatMember({ chatId: -1001, userId: 7, isSupergroup: true, api })).toBe(true);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(true);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(true);
    expect(await actions.unbanChatMemberIfBanned(-1001, 7, api)).toBe(true);
    expect(await actions.unbanChatSenderChat(-1001, -2002, api)).toBe(true);
    expect(await actions.copyMessage({ chatId: -1001, fromChatId: -2002, messageId: 8 })).toBe(91);
    expect(markSelfSent.mock.calls).toEqual([[-1001, 11], [-1001, 12], [-1001, 13], [-1001, 91]]);
    expect(logApiError).not.toHaveBeenCalled();
  });

  test("Telegram 抛错时不向业务层泄漏异常，按动作返回 false/undefined", async () => {
    const api: TelegramApi = apiWithFailures();

    expect(await actions.sendMessage({ chatId: -1001, text: "hello", api })).toBeUndefined();
    expect(await actions.sendChatAction({ chatId: -1001, action: "typing", api })).toBe(false);
    expect(await actions.sendChatAction({ chatId: -1001, action: "upload_photo", api })).toBe(false);
    expect(await actions.sendChatAction({ chatId: -1001, action: "choose_sticker", api })).toBe(false);
    await expect(actions.answerCallbackQuery({ callbackQueryId: "callback", api })).resolves.toBeUndefined();
    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBeUndefined();
    expect(await actions.sendPhoto({ chatId: -1001, bytes: new Uint8Array([1]), mimeType: "image/png", api })).toBeUndefined();
    expect(await actions.setMessageReaction({ chatId: -1001, messageId: 3, emoji: "👍", api })).toBe(false);
    expect(await actions.deleteMessage(-1001, 3, api)).toBe(false);
    expect(await actions.kickChatMember({ chatId: -1001, userId: 7, isSupergroup: true, api })).toBe(false);
    expect(await actions.banChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.isChatMember(-1001, 7, api)).toBe(false);
    expect(await actions.banChatSenderChat(-1001, -2002, api)).toBe(false);
    expect(await actions.unbanChatMemberIfBanned(-1001, 7, api)).toBe(false);
    expect(await actions.unbanChatSenderChat(-1001, -2002, api)).toBe(false);

    copyMessageApi.mockRejectedValueOnce(new Error("copy failed"));
    expect(await actions.copyMessage({ chatId: -1001, fromChatId: -2002, messageId: 8 })).toBeUndefined();
    expect(logApiError).toHaveBeenCalledTimes(16);
    expect(markSelfSent).not.toHaveBeenCalled();
  });

  test("主动取消发送时返回 undefined 且不记录 API 错误", async () => {
    const api: TelegramApi = apiWithFailures();
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

    await actions.sendChatAction({ chatId: -1001, action: "typing", api, signal });
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

  test("批量反应动作原样传递普通、自定义与清除状态", async () => {
    const setMessageReaction = mock(async (..._args: unknown[]): Promise<true> => true);
    const api: Api = { setMessageReaction } as unknown as Api;
    const signal: AbortSignal = new AbortController().signal;

    await actions.setMessageReactions({
      chatId: -1001,
      messageId: 3,
      reactions: [{ type: "custom_emoji", custom_emoji_id: "custom-1" }],
      api,
      signal,
    });
    await actions.setMessageReactions({
      chatId: -1001,
      messageId: 3,
      reactions: [],
      api,
      signal,
    });

    expect(setMessageReaction.mock.calls).toEqual([
      [-1001, 3, [{ type: "custom_emoji", custom_emoji_id: "custom-1" }], {}, signal],
      [-1001, 3, [], {}, signal],
    ]);
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
    const api: TelegramApi = apiWithSuccesses();
    const mappingError: Error = new Error("self-sent tracking failed");
    markSelfSent.mockImplementationOnce(() => {
      throw mappingError;
    });

    expect(await actions.sendSticker({ chatId: -1001, fileId: "file", api })).toBeUndefined();
    expect(logApiError).toHaveBeenCalledWith("send sticker", mappingError);
  });

  test("延迟删除只注册一个不阻止退出的 timer，并在到期后复用 deleteMessage", async () => {
    const api: TelegramApi = apiWithSuccesses();
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

  test("正常停机在截止前提前兑现待删消息，并等待删除请求结算", async () => {
    const api: TelegramApi = apiWithSuccesses();
    actions.deleteMessageAfter({ chatId: -1001, messageId: 45, delayMs: 30_000, api });

    expect(api.deleteMessage).not.toHaveBeenCalled();
    await expect(actions.drainPendingMessageDeletions(1_000)).resolves.toBe("flushed");
    expect(api.deleteMessage).toHaveBeenCalledWith(-1001, 45);
  });

  test("timer 已认领的删除仍进入在途集合，Worker flush 不会漏等", async () => {
    let release!: () => void;
    const deleteMessage = mock(async (): Promise<true> => {
      await new Promise<void>((resolve: () => void): void => { release = resolve; });
      return true;
    });
    const api: Api = { deleteMessage } as unknown as Api;
    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    let scheduled: (() => void) | null = null;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
      scheduled = callback;
      return { unref(): void {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      actions.deleteMessageAfter({ chatId: -1001, messageId: 51, delayMs: 500, api });
      scheduled!();
      const inFlight: readonly Promise<void>[] =
        actions.flushPendingMessageDeletions();
      expect(inFlight).toHaveLength(1);
      release();
      await settleTestBatch(inFlight);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("停机 flush 仅合批显式条目，并按 deleteMessages 的 100 条上限分片", async () => {
    const api: TelegramApi = apiWithSuccesses();
    for (let messageId: number = 1; messageId <= 101; messageId++) {
      actions.deleteMessageAfter({
        chatId: -1001,
        messageId,
        delayMs: 30_000,
        api,
        batchOnFlush: true,
      });
    }
    actions.deleteMessageAfter({
      chatId: -2002,
      messageId: 201,
      delayMs: 30_000,
      api,
      batchOnFlush: true,
    });
    actions.deleteMessageAfter({
      chatId: -1001,
      messageId: 301,
      delayMs: 30_000,
      api,
    });

    await settleTestBatch(actions.flushPendingMessageDeletions());
    expect(api.deleteMessages).toHaveBeenCalledTimes(3);
    expect(api.deleteMessages).toHaveBeenNthCalledWith(
      1,
      -1001,
      Array.from({ length: 100 }, (_value: unknown, index: number): number => index + 1)
    );
    expect(api.deleteMessages).toHaveBeenNthCalledWith(2, -1001, [101]);
    expect(api.deleteMessages).toHaveBeenNthCalledWith(3, -2002, [201]);
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).toHaveBeenCalledWith(-1001, 301);
  });

  test("延迟删除失败走统一 Telegram 错误日志，但不阻止停机", async () => {
    const api: TelegramApi = apiWithFailures();
    actions.deleteMessageAfter({ chatId: -1001, messageId: 46, delayMs: 30_000, api });

    await expect(actions.drainPendingMessageDeletions(1_000)).resolves.toBe("flushed");
    expect(logApiError).toHaveBeenCalledWith("delete message", expect.any(Error));
  });

  test("零预算不启动新的 Telegram 删除请求", async () => {
    const api: TelegramApi = apiWithSuccesses();
    actions.deleteMessageAfter({ chatId: -1001, messageId: 47, delayMs: 30_000, api });

    await expect(actions.drainPendingMessageDeletions(0)).resolves.toBe("timedOut");
    expect(api.deleteMessage).not.toHaveBeenCalled();
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

    await actions.kickChatMember({ chatId: -1001, userId: 7, isSupergroup: true, api });
    // 空 options 与不传等价，关键是**没有** only_if_banned。
    expect(unbanChatMember).toHaveBeenLastCalledWith(-1001, 7, {});
  });
});

describe("黑名单封禁结果归一化", () => {
  test("权限不足与偶发失败必须分成两档", async () => {
    // 缺封禁权限时重试多少次都一样，只有权限本身变了才有意义；把它跟限流、
    // 网络抖动混成一个 false，主线程就只能按时间盲目重试（见 infra/blocklist/）。
    const banChatMember = mock(async (..._args: unknown[]) => true);
    const api: Api = { banChatMember } as unknown as Api;
    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("banned");

    banChatMember.mockImplementation((): never => {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: not enough rights to restrict/unrestrict chat member" }, "banChatMember", {});
    });
    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("forbidden");

    banChatMember.mockImplementation((): never => {
      throw new GrammyError("x", { ok: false, error_code: 403, description: "Forbidden: bot was kicked" }, "banChatMember", {});
    });
    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("forbidden");

    // 同为 400 的其它错误不能被当成权限问题：那会让一批本可重试的处置永久
    // 挂起，等一个不会到来的授权。
    banChatMember.mockImplementation((): never => {
      throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: user not found" }, "banChatMember", {});
    });
    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("failed");

    banChatMember.mockImplementation((): never => { throw new Error("socket hang up"); });
    expect(await actions.banChatMemberWithOutcome(-1001, 7, api)).toBe("failed");
  });

  test("banChatMember 传 revoke_messages", async () => {
    // /block、秒踢、补扫与广告检测命中都走这一条；该参数撤销被移除成员对既有
    // 群消息的访问，并不删除 TA 发给群内其他成员的历史消息。
    const banChatMember = mock(async (..._args: unknown[]) => true);
    const api: Api = { banChatMember } as unknown as Api;

    await actions.banChatMember(-1001, 7, api);
    expect(banChatMember).toHaveBeenLastCalledWith(-1001, 7, { revoke_messages: true });
  });
});

describe("editMessageText 的失败分档", () => {
  function editApi(reject: () => never): Api {
    return { editMessageText: mock(async (..._args: unknown[]): Promise<never> => reject()) } as unknown as Api;
  }

  test("「内容本就相同」报成功且不记 API 错误", async () => {
    // 翻页按钮把同一页再点一次就会撞上它：目标状态已经达成，调用方要的是
    // 「这条消息现在显示的是这一页」。
    logApiError.mockClear();
    const api: Api = editApi((): never => {
      throw new GrammyError("x", {
        ok: false,
        error_code: 400,
        description: "Bad Request: message is not modified",
      }, "editMessageText", {});
    });

    expect(await actions.editMessageText({ chatId: -1001, messageId: 7, text: "x", api: api as never }))
      .toBe(true);
    expect(logApiError).not.toHaveBeenCalled();
  });

  test("真实失败报失败并记一次 API 错误", async () => {
    logApiError.mockClear();
    const api: Api = editApi((): never => { throw new Error("socket hang up"); });

    expect(await actions.editMessageText({ chatId: -1001, messageId: 7, text: "x", api: api as never }))
      .toBe(false);
    expect(logApiError).toHaveBeenCalledTimes(1);
  });

  test("调用方 signal 已 abort 时与同类动作一样不记 API 错误", async () => {
    // 本文件其余动作全部按 `actionSignal?.aborted !== true` 判定；editMessageText
    // 曾经是唯一的例外，把停机/取消造成的失败记成 Telegram API 错误。
    const controller: AbortController = new AbortController();
    controller.abort();
    const abortRejection = (): never => { throw new DOMException("aborted", "AbortError"); };

    logApiError.mockClear();
    expect(await actions.editMessageText({
      chatId: -1001, messageId: 7, text: "x",
      api: editApi(abortRejection) as never,
      signal: controller.signal,
    })).toBe(false);
    const editCalls: number = logApiError.mock.calls.length;

    logApiError.mockClear();
    await actions.sendMessageWithResult({
      chatId: -1001, text: "x",
      api: { sendMessage: mock(async (..._args: unknown[]): Promise<never> => abortRejection()) } as never,
      signal: controller.signal,
    });
    const sendCalls: number = logApiError.mock.calls.length;

    expect(editCalls).toBe(sendCalls);
    expect(editCalls).toBe(0);
  });
});
