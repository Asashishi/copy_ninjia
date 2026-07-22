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
mock.module("../../src/infra/storage/stateStore", () => ({
  clearChatStateField: () => false,
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => undefined,
  getChatState: () => ({ isAIChatEnabled: true, quietUntil: Number.MAX_SAFE_INTEGER }),
  getOrCreateChatState: () => ({}),
  saveStateInBackground: () => {},
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
    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 8,
      text: "hello @bob",
    });
  });

  test("@ 机器人同时回复别人时把原消息引用一并交给 AI", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 81,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        text: "@test_bot 你怎么看",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        reply_to_message: {
          message_id: 80,
          date: 1,
          chat: { id: -100800, type: "supergroup", title: "Test Group" },
          from: { id: 456, is_bot: false, username: "bob_dev", first_name: "Bob" },
          text: "TypeScript 比 JavaScript 简单",
        },
      },
    } as any);

    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 81,
      text: "@test_bot 你怎么看",
      replyTo: {
        messageId: 80,
        id: 456,
        firstName: "Bob",
        lastName: "",
        username: "bob_dev",
        text: "TypeScript 比 JavaScript 简单",
      },
    });
    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 81,
      imageGenerationRequested: true,
    });
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
    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100900,
      senderId: -100900,
      firstName: "News Channel",
      lastName: "",
      username: "news_channel",
      messageId: 9,
      text: "channel post",
    });
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
    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "photo",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "photo caption",
      fileId: "photo-file",
      fileUniqueId: "photo-unique",
      width: 640,
      height: 480,
      messageId: 10,
      commentOnResolve: false,
      imageGenerationRequested: false,
      directTrigger: undefined,
    });
  });
});
