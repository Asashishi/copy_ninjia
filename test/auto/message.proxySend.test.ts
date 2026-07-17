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
mock.module("../../src/infra/storage", () => ({
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => targetChatId,
  getChatState: () => ({}),
  getOrCreateChatState: () => ({}),
  saveState: async () => {},
}));
mock.module("../../src/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../src/users/senderIdentity", () => ({ cacheSender: (message: any) => message.from?.id }));
mock.module("../../src/aiChat", () => ({ recordChatMessage: () => {}, recordChatMedia: () => {}, generateAndSendReply: () => {} }));
mock.module("../../src/infra/selfSentTracker", () => ({ isSelfSent: () => false }));

const { handleIncomingMessage } = await import("../../src/auto/message");
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
});
