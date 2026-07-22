import { beforeEach, describe, expect, mock, test } from "bun:test";

const copyMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 42);
const sendMessageMock = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
mock.module("../../src/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: sendMessageMock,
  bot: { api: {} },
  buildFileDownloadUrl: () => "",
  logApiError: () => {},
}));

const targetChatId = -1001234567890;
let chatState: { isJATranslationEnabled?: boolean } = {};
mock.module("../../src/infra/storage/stateStore", () => ({
  clearChatStateField: () => true,
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => targetChatId,
  getChatState: () => chatState,
  getOrCreateChatState: () => ({}),
  persistAuthoritativeState: async (): Promise<void> => {},
  saveStateInBackground: () => {},
}));
mock.module("../../src/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../src/users/senderIdentity", () => ({ cacheSender: (message: any) => message.from?.id }));
mock.module("../../src/aiChat", () => ({ recordChatMessage: () => {}, recordChatMedia: () => {}, generateAndSendReply: () => {} }));
mock.module("../../src/infra/selfSentTracker", () => ({ isSelfSent: () => false }));

const { handleIncomingMessage } = await import("../../src/auto/message");
const { resolveEffectiveCopyMode } = await import("../../src/auto/message/echo");
const { SUPER_ADMIN_USER_ID } = await import("../../src/infra/config");

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
    copyMessageMock.mockClear();
    sendMessageMock.mockClear();
  });

  test("全局会话活动时也不会复制外部用户私聊，只复制超管本人的消息", async () => {
    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID + 1));
    expect(copyMessageMock).not.toHaveBeenCalled();

    await handleIncomingMessage(privateMessageCtx(SUPER_ADMIN_USER_ID));
    expect(copyMessageMock).toHaveBeenCalledTimes(1);
    expect(copyMessageMock).toHaveBeenCalledWith(targetChatId, SUPER_ADMIN_USER_ID, 7);
  });

  test("日语翻译缺省关闭，只有显式 true 才保留 ja 模式", () => {
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBeUndefined();
    chatState.isJATranslationEnabled = false;
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBeUndefined();
    chatState.isJATranslationEnabled = true;
    expect(resolveEffectiveCopyMode(targetChatId, "ja")).toBe("ja");
    expect(resolveEffectiveCopyMode(targetChatId, "nya")).toBe("nya");
  });
});
