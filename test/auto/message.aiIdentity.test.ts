import { beforeEach, describe, expect, test } from "bun:test";
import { aiRecordMessageFixture, aiReplyReferenceFixture } from "../helpers/aiMemoryFixtures";
// 六个公共模块桩收在 helper 里（见 test/helpers/autoMessageMocks.ts）；
// 必须在下面的 await import 之前登记。
import {
  generateAndSendReplyMock,
  isBotOwnMessageMock,
  needsBotOwnMessageWaitMock,
  recordChatMediaMock,
  recordChatMessageMock,
  resetAutoMessageMocks,
  waitForBotOwnMessageMock,
} from "../helpers/autoMessageMocks";

const { handleIncomingMessage } = await import("../../packages/auto/message");

const botInfo = { id: 999999, username: "test_bot", first_name: "TestBot" };

describe("AI 缓存发送者 username 传递", () => {
  beforeEach(() => {
    resetAutoMessageMocks();
    // 本文件专测频道/自动转发的自发消息等待，因此把 needsBotOwnMessageWait 换成
    // 生产语义（helper 的缺省是恒 false，供不关心这条分支的用例使用）。
    needsBotOwnMessageWaitMock.mockImplementation((message: any): boolean =>
      message.chat.type === "channel" ||
      (message.is_automatic_forward === true && message.forward_origin?.type === "channel")
    );
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
    expect(waitForBotOwnMessageMock).not.toHaveBeenCalled();
    expect(recordChatMessageMock).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 8,
      text: "hello @bob",
    }));
  });

  test("转发文字消息把来源路径一并交给 AI", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 82,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group" },
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        text: "转来的消息",
        forward_origin: {
          type: "channel",
          date: 1,
          chat: { id: -100666, type: "channel", title: "东京日报", username: "tokyo_daily" },
          message_id: 9,
        },
      },
    } as any);

    expect(recordChatMessageMock).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 82,
      forwardedFrom: "频道 [id:-100666] [username:@tokyo_daily] 东京日报",
      text: "转来的消息",
    }));
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

    expect(recordChatMessageMock).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 81,
      text: "@test_bot 你怎么看",
      replyTo: aiReplyReferenceFixture({
        messageId: 80,
        id: 456,
        firstName: "Bob",
        lastName: "",
        username: "bob_dev",
        text: "TypeScript 比 JavaScript 简单",
      }),
    }));
    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 81,
      imageGenerationRequested: true,
      imageGenerationReference: undefined,
      isRandomTrigger: false,
      messageThreadId: undefined,
    });
  });

  test("论坛话题里的直接触发把话题 id 一路带进 trigger，其它话题/General 不受影响", async () => {
    // 话题群里 AI 的主动发送全靠这个 id 落回原话题；漏掉它整轮都会掉进 General。
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 90,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group", is_forum: true },
        message_thread_id: 77,
        is_topic_message: true,
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        text: "@test_bot 在话题里问",
        entities: [{ type: "mention", offset: 0, length: 9 }],
      },
    } as any);

    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 90,
      imageGenerationRequested: true,
      imageGenerationReference: undefined,
      isRandomTrigger: false,
      messageThreadId: 77,
    });
  });

  test("General 里的直接触发不带话题：Bot API 里「没有话题」就是 General", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 91,
        date: 1,
        chat: { id: -100800, type: "supergroup", title: "Test Group", is_forum: true },
        from: { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" },
        text: "@test_bot 在 General 问",
        entities: [{ type: "mention", offset: 0, length: 9 }],
      },
    } as any);

    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 91,
      imageGenerationRequested: true,
      imageGenerationReference: undefined,
      isRandomTrigger: false,
      messageThreadId: undefined,
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
    expect(recordChatMessageMock).toHaveBeenCalledWith(aiRecordMessageFixture({
      chatId: -100900,
      senderId: -100900,
      firstName: "News Channel",
      lastName: "",
      username: "news_channel",
      messageId: 9,
      text: "channel post",
    }));
  });

  test("频道 update 先到时等待 Worker 标记，命中后不进入自动流水线", async () => {
    let releaseMarker: ((matched: boolean) => void) | undefined;
    waitForBotOwnMessageMock.mockImplementationOnce((): Promise<boolean> =>
      new Promise<boolean>((resolve: (matched: boolean) => void): void => {
        releaseMarker = resolve;
      }));
    const handling: Promise<void> = handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 91,
        date: 1,
        chat: { id: -100900, type: "channel", title: "News Channel" },
        text: "bot post",
      },
    } as any);
    await Promise.resolve();

    expect(recordChatMessageMock).not.toHaveBeenCalled();
    expect(waitForBotOwnMessageMock).toHaveBeenCalledTimes(1);
    releaseMarker!(true);
    await handling;

    expect(recordChatMessageMock).not.toHaveBeenCalled();
    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("自发消息已同步登记时直接跳过，不再进入异步等待", async () => {
    isBotOwnMessageMock.mockImplementationOnce((): boolean => true);

    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 92,
        date: 1,
        chat: { id: -100900, type: "channel", title: "News Channel" },
        text: "known bot post",
      },
    } as any);

    expect(waitForBotOwnMessageMock).not.toHaveBeenCalled();
    expect(recordChatMessageMock).not.toHaveBeenCalled();
    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
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
      type: "recordMedia",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 10,
      replyTo: undefined,
      forwardedFrom: undefined,
      persistImmediately: false,
      messageThreadId: undefined,
      kind: "photo",
      caption: "photo caption",
      fileId: "photo-file",
      fileUniqueId: "photo-unique",
      width: 640,
      height: 480,
      commentOnResolve: false,
      stickerFallbackText: undefined,
      voiceMime: undefined,
      voiceDurationSeconds: 0,
      directTriggerReason: undefined,
    });
  });
});
