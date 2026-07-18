import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/** 「拿媒体直接叫机器人」的触发判定（见 src/auto/message/ 的媒体分支）：
 * 有视觉素材时经 recordChatMedia 带 directTrigger 走「先试缓存、解析完成再
 * 回答」的必回管线；没有素材时记完兜底行直接触发。storage mock 里
 * quietUntil 恒为将来时刻——必回路径与文字回复/@ 一致地无视 /quiet，正好
 * 顺带验证这一点。 */

const recordChatMessageMock = mock((..._args: unknown[]): void => {});
const recordChatMediaMock = mock((..._args: unknown[]): void => {});
const generateAndSendReplyMock = mock((..._args: unknown[]): void => {});
const copyMessageMock = mock(async (..._args: unknown[]): Promise<undefined> => undefined);
let quietUntil: number = Number.MAX_SAFE_INTEGER;

mock.module("../../src/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: async (): Promise<undefined> => undefined,
  bot: { api: {} },
  buildFileDownloadUrl: () => "",
  logApiError: () => {},
}));
mock.module("../../src/infra/storage/stateStore", () => ({
  clearChatStateField: () => false,
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => undefined,
  getChatState: () => ({ isAIChatEnabled: true, quietUntil }),
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

// tryClaimUserReplyTrigger 的 15s 每人触发冷却按真实 Date.now() 计时（见
// src/auto/message/）：本文件多个用例共用同一个 chatId + alice.id 夹具，
// 不清空会导致后面的用例被前一个用例占用的冷却名额挡住、断言失败。
const { userReplyTriggerTimes } = await import("../../src/cache/auto");

// 全量跑时 test/ai/stickers/catalog.test.ts 会把 pickStickerVisionSource 换成
// 恒返回素材的桩（bun 的 mock.module 是进程级注册表，跨文件生效），这里按
// 真实语义重新钉住：静态贴纸下载本体，动态/视频贴纸只有缩略图可用、没有
// 缩略图则没有素材（与 src/ai/stickers/sets.ts 的实现一致）。
const realStickerSets = await import("../../src/ai/stickers/sets");
mock.module("../../src/ai/stickers/sets", () => ({
  ...realStickerSets,
  pickStickerVisionSource: (sticker: any) => {
    const downloadFileId: string | undefined = !sticker.is_animated && !sticker.is_video ? sticker.file_id : sticker.thumbnail?.file_id;
    if (!downloadFileId) return null;
    return { fileId: downloadFileId, fileUniqueId: sticker.file_unique_id };
  },
}));

const { handleIncomingMessage } = await import("../../src/auto/message");
const { clearAiReplyActivity } = await import("../../src/auto/message/aiReplyActivity");

const botInfo = { id: 999999, username: "test_bot", first_name: "TestBot" };
const chat = { id: -100800, type: "supergroup", title: "Test Group" };
const alice = { id: 123, is_bot: false, username: "alice_dev", first_name: "Alice", last_name: "Tester" };
const botReply = {
  message_id: 50,
  date: 1,
  chat,
  from: { id: botInfo.id, is_bot: true, first_name: "TestBot", username: "test_bot" },
  text: "机器人之前说的话",
};

describe("媒体直接叫机器人", () => {
  beforeEach(() => {
    recordChatMessageMock.mockClear();
    recordChatMediaMock.mockClear();
    generateAndSendReplyMock.mockClear();
    copyMessageMock.mockClear();
    quietUntil = Number.MAX_SAFE_INTEGER;
    userReplyTriggerTimes.clear();
    clearAiReplyActivity();
  });

  afterAll(clearAiReplyActivity);

  test("静态贴纸回复机器人：recordChatMedia 带上 directTrigger 与被回复文本，不掷评价骰", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 11,
        date: 1,
        chat,
        from: alice,
        reply_to_message: botReply,
        sticker: { file_id: "st-file", file_unique_id: "st-uid", width: 512, height: 512, is_animated: false, is_video: false, type: "regular", emoji: "😂", set_name: "cool_pack" },
      },
    } as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "sticker", -100800, 123, "Alice", "Tester", "alice_dev", "",
      "st-file", "st-uid", 11, false,
      "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      { reason: "reply", repliedBotText: "机器人之前说的话" }
    );
    // 触发在 Worker 侧等描述就绪后才发生，主线程不直接 trigger。
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("无视觉素材的贴纸回复机器人：记完兜底行直接按回复机器人触发", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 12,
        date: 1,
        chat,
        from: alice,
        reply_to_message: botReply,
        // 动态贴纸且没有缩略图：pickStickerVisionSource 返回 null。
        sticker: { file_id: "anim-file", file_unique_id: "anim-uid", width: 512, height: 512, is_animated: true, is_video: false, type: "regular", emoji: "😅" },
      },
    } as any);

    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(recordChatMessageMock).toHaveBeenCalledWith(-100800, 123, "Alice", "Tester", "alice_dev", "（发了一枚贴纸：情绪含义 😅）");
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).toHaveBeenCalledWith(-100800, 12, "机器人之前说的话");
  });

  test("同一用户连续两次直接叫机器人都交给 Worker，不被 15 秒随机冷却吞掉", async () => {
    for (const messageId of [21, 22]) {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: messageId,
          date: 1,
          chat,
          from: alice,
          reply_to_message: botReply,
          sticker: { file_id: `anim-${messageId}`, file_unique_id: `anim-uid-${messageId}`, width: 512, height: 512, is_animated: true, is_video: false, type: "regular", emoji: "😅" },
        },
      } as any);
    }

    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(2);
    expect(userReplyTriggerTimes.size).toBe(0);
  });

  test("随机媒体评价命中后不再落入随机复读", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 23,
          date: 1,
          chat,
          from: alice,
          sticker: { file_id: "st-random", file_unique_id: "st-random-uid", width: 512, height: 512, is_animated: false, is_video: false, type: "regular", emoji: "😂", set_name: "cool_pack" },
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "sticker", -100800, 123, "Alice", "Tester", "alice_dev", "",
      "st-random", "st-random-uid", 23, true,
      "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      undefined
    );
    expect(copyMessageMock).not.toHaveBeenCalled();
  });

  test("贴纸回复的不是机器人：不带 directTrigger，也不触发回复", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 13,
        date: 1,
        chat,
        from: alice,
        reply_to_message: { ...botReply, from: { id: 456, is_bot: false, first_name: "Bob" } },
        sticker: { file_id: "st-file", file_unique_id: "st-uid", width: 512, height: 512, is_animated: false, is_video: false, type: "regular", emoji: "😂", set_name: "cool_pack" },
      },
    } as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "sticker", -100800, 123, "Alice", "Tester", "alice_dev", "",
      "st-file", "st-uid", 13, false,
      "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      undefined
    );
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("图片 caption 里 @ 机器人：recordChatMedia 带 mention directTrigger，静默期也必回", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 14,
        date: 1,
        chat,
        from: alice,
        caption: "看看这个 @test_bot",
        caption_entities: [{ type: "mention", offset: 5, length: 9 }],
        photo: [{ file_id: "photo-file", file_unique_id: "photo-uid", width: 640, height: 480 }],
      },
    } as any);

    expect(recordChatMediaMock).toHaveBeenCalledTimes(1);
    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "photo", -100800, 123, "Alice", "Tester", "alice_dev", "看看这个 @test_bot",
      "photo-file", "photo-uid", 14, false, undefined, { reason: "mention" }
    );
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("文字回复自己的消息不参与随机 AI 回复", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 31,
          date: 1,
          chat,
          from: alice,
          text: "再补充一句",
          reply_to_message: {
            message_id: 30,
            date: 1,
            chat,
            from: alice,
            text: "我刚才说的",
          },
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(recordChatMessageMock).toHaveBeenCalledWith(-100800, 123, "Alice", "Tester", "alice_dev", "再补充一句");
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("文字回复别人仍可参与随机 AI 回复", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 32,
          date: 1,
          chat,
          from: alice,
          text: "回复 Bob",
          reply_to_message: {
            message_id: 30,
            date: 1,
            chat,
            from: { id: 456, is_bot: false, first_name: "Bob" },
            text: "Bob 说的话",
          },
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(generateAndSendReplyMock).toHaveBeenCalledWith(-100800, 32, undefined, true);
  });

  test("冷群首条使用 1/149 动态概率，不再沿用旧固定概率", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    // 0.01 低于旧固定 1/10，但高于冷群首条 1/149；也恰好不小于 1/100 随机复读。
    Math.random = () => 0.01;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 37,
          date: 1,
          chat,
          from: alice,
          text: "冷群的第一句普通话",
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
    expect(copyMessageMock).not.toHaveBeenCalled();
  });

  test("回复自己发的图片不参与随机 AI 评价", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 35,
          date: 1,
          chat,
          from: alice,
          caption: "补一张图",
          reply_to_message: {
            message_id: 30,
            date: 1,
            chat,
            from: alice,
            text: "我刚才说的",
          },
          photo: [{ file_id: "self-photo", file_unique_id: "self-photo-uid", width: 640, height: 480 }],
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(recordChatMediaMock).toHaveBeenCalledWith(
      "photo", -100800, 123, "Alice", "Tester", "alice_dev", "补一张图",
      "self-photo", "self-photo-uid", 35, false, undefined, undefined
    );
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("@ 其他用户不参与随机 AI 回复，@ 机器人仍走直接触发", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 33,
          date: 1,
          chat,
          from: alice,
          text: "找你 @bob",
          entities: [{ type: "mention", offset: 3, length: 4 }],
        },
      } as any);
      expect(generateAndSendReplyMock).not.toHaveBeenCalled();

      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 36,
          date: 1,
          chat,
          from: alice,
          text: "找 Bob",
          entities: [{ type: "text_mention", offset: 2, length: 3, user: { id: 456, is_bot: false, first_name: "Bob" } }],
        },
      } as any);
      expect(generateAndSendReplyMock).not.toHaveBeenCalled();

      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 34,
          date: 1,
          chat,
          from: alice,
          text: "过来 @test_bot",
          entities: [{ type: "mention", offset: 3, length: 9 }],
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).toHaveBeenCalledWith(-100800, 34, undefined);
  });
});
