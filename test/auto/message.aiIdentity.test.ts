import { beforeEach, describe, expect, mock, test } from "bun:test";

const recordChatMessageMock = mock((..._args: unknown[]): void => {});
const recordChatMediaMock = mock((..._args: unknown[]): void => {});
const generateAndSendReplyMock = mock((..._args: unknown[]): void => {});

mock.module("../../src/infra/telegram", () => ({
  copyMessage: async (): Promise<undefined> => undefined,
  sendMessage: async (): Promise<undefined> => undefined,
  bot: { api: {} },
  buildFileDownloadUrl: () => "",
  logApiError: () => {},
}));
mock.module("../../src/infra/storage", () => ({
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => undefined,
  getChatState: () => ({ isUseAIChat: true, quietUntil: Number.MAX_SAFE_INTEGER }),
  getOrCreateChatState: () => ({}),
  saveState: async () => {},
}));
mock.module("../../src/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../src/users/senderIdentity", () => ({ cacheSender: (message: any) => message.sender_chat?.id ?? message.from?.id }));
mock.module("../../src/aiChat", () => ({
  recordChatMessage: recordChatMessageMock,
  recordChatMedia: recordChatMediaMock,
  generateAndSendReply: generateAndSendReplyMock,
}));
mock.module("../../src/infra/selfSentTracker", () => ({ isSelfSent: () => false }));

const { handleIncomingMessage } = await import("../../src/auto/message");

const botInfo = { id: 999999, username: "test_bot", first_name: "TestBot" };

describe("AI 缓存发送者 username 传递", () => {
  beforeEach(() => {
    recordChatMessageMock.mockClear();
    recordChatMediaMock.mockClear();
    generateAndSendReplyMock.mockClear();
  });

  test("普通用户文字消息把 username 一并交给 AI", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 8,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        text: "hello @bob",
      },
    } as any);

    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
    expect(recordChatMessageMock).toHaveBeenCalledWith(-100800, 123, "Alice", "Tester", "alice_dev", "hello @bob");
  });

  test("频道帖子使用频道的 username 和 title", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 9,
        date: 1,
        chat: { id: -100900, type: "channel", title: "News Channel", username: "news_channel" },
        text: "channel post",
      },
    } as any);

    expect(recordChatMessageMock).toHaveBeenCalledTimes(1);
    expect(recordChatMessageMock).toHaveBeenCalledWith(-100900, -100900, "News Channel", "", "news_channel", "channel post");
  });

  test("媒体消息同样把发送者 username 交给 AI", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 10,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        caption: "photo caption",
        photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 640, height: 480 }],
      },
    } as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "photo", -100800, 123, "Alice", "Tester", "alice_dev", "photo caption",
      "photo-file", "photo-unique", 10, false
    );
  });
});
