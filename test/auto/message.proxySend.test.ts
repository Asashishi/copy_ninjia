import { beforeEach, describe, expect, mock, test } from "bun:test";

const copyMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 42);
const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
mock.module("../../packages/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: sendMessageMock,
  bot: { api: {} },
  logApiError: () => {},
}));

const targetChatId = -1001234567890;
let chatState: { isJATranslationEnabled?: boolean } = {};
// g-auth.json 的可用性；坏掉时自动复读必须退化成普通复制，不能假装翻译过。
let jaReadiness: { ok: true } | { ok: false; failure: { file: string; reason: string } } = { ok: true };
mock.module("../../packages/config/readiness", () => ({
  jaTranslateConfigReadiness: () => jaReadiness,
  // 自动流水线同一条路径上还挂着 AI 闲聊的判定；这个文件只考 ja，让它恒通过。
  aiChatConfigReadiness: () => ({ ok: true }),
  adDetectConfigReadiness: () => ({ ok: true }),
}));
const clearChatStateFieldMock = mock((..._args: unknown[]): boolean => true);
const persistChatStateMock = mock(async (..._args: unknown[]): Promise<void> => {});
mock.module("../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: clearChatStateFieldMock,
  activeCopyTargetIdIn: (): undefined => undefined,
  activeCopyModeIn: (): undefined => undefined,
  getActiveProxySendTarget: () => targetChatId,
  getChatState: () => chatState,
  getOrCreateChatState: () => ({}),
  persistChatState: persistChatStateMock,
  saveChatStateInBackground: () => {},
}));
mock.module("../../packages/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../packages/users/senderIdentity", () => ({ cacheSender: (message: any) => message.from?.id }));
mock.module("../../packages/aiChat", () => ({ recordChatMessage: () => {}, recordChatMedia: () => {}, generateAndSendReply: () => {} }));
mock.module("../../packages/infra/selfSentTracker", () => ({
  isSelfSent: () => false,
  isBotOwnMessage: () => false,
  needsBotOwnMessageWait: () => false,
  waitForBotOwnMessage: async (): Promise<boolean> => false,
}));

const { handleIncomingMessage } = await import("../../packages/auto/message");
const { resolveEffectiveCopyMode } = await import("../../packages/auto/message/echo");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/telegram");

function privateMessageCtx(userId: number): any {
  return {
    me: { id: 999999, username: "test_bot", first_name: "TestBot" },
    msg: {
      message_id: 7,
      date: 1,
      chat: { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text: "private text",
    },
  };
}

describe("/send 私聊中转权限", () => {
  beforeEach(() => {
    chatState = {};
    jaReadiness = { ok: true };
    copyMessageMock.mockClear();
    copyMessageMock.mockImplementation(async (): Promise<number | undefined> => 42);
    sendMessageMock.mockClear();
    clearChatStateFieldMock.mockClear();
    persistChatStateMock.mockClear();
  });

  test("全局会话活动时也不会复制外部用户私聊，只复制超管本人的消息", async () => {
    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID + 1));
    expect(copyMessageMock).not.toHaveBeenCalled();

    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID));
    expect(copyMessageMock).toHaveBeenCalledTimes(1);
    expect(copyMessageMock).toHaveBeenCalledWith({
      chatId: targetChatId,
      fromChatId: SUPER_ADMIN_USER_ID,
      messageId: 7,
    });
  });

  test("日语翻译缺省关闭，只有显式 true 才保留 ja 模式", () => {
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBeUndefined();
    chatState.isJATranslationEnabled = false;
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBeUndefined();
    chatState.isJATranslationEnabled = true;
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBe("ja");
    expect(resolveEffectiveCopyMode(targetChatId, "nya")).toBe("nya");
  });

  test("服务账号密钥坏掉时 ja 退化成普通复制，其余模式照旧", () => {
    // 不挡的话翻译会在底层静默失败并原样发出中文原文——那与「翻译服务抖了
    // 一下」不可区分，而退化成普通复制至少行为是确定的。
    chatState.isJATranslationEnabled = true;
    jaReadiness = { ok: false, failure: { file: "g-auth.json", reason: "missing" } };
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBeUndefined();
    expect(resolveEffectiveCopyMode(targetChatId, "nya")).toBe("nya");
  });

  /**
   * 转发失败必须**当场结束会话**并回执一句。
   *
   * 不结束的话超管此后每条私聊都会被这条静默失败的路径吞掉：`copyMessage` 返回
   * undefined 不抛错，会话标志还开着，于是消息既没转出去、也不落进任何别的处理，
   * 而超管那头看不到任何异常——正是这条路径存在的全部理由。
   */
  test("转发失败时关掉中转会话、落盘并回执，不再静默吞掉后续私聊", async () => {
    copyMessageMock.mockImplementation(async (): Promise<number | undefined> => undefined);

    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID));

    expect(clearChatStateFieldMock).toHaveBeenCalledWith(targetChatId, "isProxySendEnabled");
    expect(persistChatStateMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const notice = sendMessageMock.mock.calls[0]![0] as { chatId: number; text: string };
    expect(notice.chatId).toBe(SUPER_ADMIN_USER_ID);
    expect(notice.text).toContain(String(targetChatId));
  });

  test("转发成功时不碰会话状态，也不发回执", async () => {
    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID));

    expect(clearChatStateFieldMock).not.toHaveBeenCalled();
    expect(persistChatStateMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
