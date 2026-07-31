import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/** 「拿媒体直接叫机器人」的触发判定（见 packages/auto/message/ 的媒体分支）：
 * 有视觉素材时经 recordChatMedia 带 directTrigger 走「先试缓存、解析完成再
 * 回答」的必回管线；没有素材时记完兜底行直接触发。storage mock 里
 * quietUntil 恒为将来时刻——必回路径与文字回复/@ 一致地无视 /quiet，正好
 * 顺带验证这一点。 */

const recordChatMessageMock = mock((..._args: unknown[]): void => {});
const recordChatMediaMock = mock((..._args: unknown[]): void => {});
const generateAndSendReplyMock = mock((..._args: unknown[]): void => {});
const copyMessageMock = mock(async (..._args: unknown[]): Promise<undefined> => undefined);
let quietUntil: number = Date.now() + 60_000;
let aiChatEnabled: boolean = true;

mock.module("../../packages/infra/telegram", () => ({
  copyMessage: copyMessageMock,
  sendMessage: async (): Promise<undefined> => undefined,
  bot: { api: {} },
  logApiError: () => {},
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: () => false,
  getActiveCopyIn: () => null,
  getActiveProxySendTarget: () => undefined,
  getChatState: () => ({ isAIChatEnabled: aiChatEnabled, quietUntil }),
  getOrCreateChatState: () => ({}),
  persistAuthoritativeState: async (): Promise<void> => {},
  saveStateInBackground: () => {},
}));
mock.module("../../packages/infra/chatTitle", () => ({ recordChatTitleFromChat: () => {} }));
mock.module("../../packages/users/senderIdentity", () => ({ cacheSender: (message: any) => message.sender_chat?.id ?? message.from?.id }));
mock.module("../../packages/aiChat", () => ({
  recordChatMessage: recordChatMessageMock,
  recordChatMedia: recordChatMediaMock,
  generateAndSendReply: generateAndSendReplyMock,
}));
mock.module("../../packages/infra/selfSentTracker", () => ({ isSelfSent: () => false, isBotOwnMessage: () => false }));

// tryClaimUserReplyTrigger 的 15s 每人触发冷却按真实 Date.now() 计时（见
// packages/auto/message/）：本文件多个用例共用同一个 chatId + alice.id 夹具，
// 不清空会导致后面的用例被前一个用例占用的冷却名额挡住、断言失败。
const { userReplyTriggerTimes } = await import("../../packages/cache/main/auto");
const { clearUserReplyTriggerTimes } =
  await import("../../packages/auto/message/triggerPolicy");

// 全量跑时 test/aiChat/ai/stickers/catalog.test.ts 会把 pickStickerVisionSource 换成
// 恒返回素材的桩（bun 的 mock.module 是进程级注册表，跨文件生效），这里按
// 真实语义重新钉住：静态贴纸下载本体，动态/视频贴纸只有缩略图可用、没有
// 缩略图则没有素材（与 packages/aiChat/ai/stickers/describe.ts 的实现一致）。
const realStickerDescribe = await import("../../packages/aiChat/ai/stickers/describe");
mock.module("../../packages/aiChat/ai/stickers/describe", () => ({
  ...realStickerDescribe,
  pickStickerVisionSource: (sticker: any) => {
    const source: any = !sticker.is_animated && !sticker.is_video ? sticker : sticker.thumbnail;
    if (!source?.file_id) return null;
    return {
      fileId: source.file_id,
      fileUniqueId: sticker.file_unique_id,
      width: source.width,
      height: source.height,
    };
  },
}));

const { handleIncomingMessage } = await import("../../packages/auto/message");
const { clearAiReplyActivity } = await import("../../packages/auto/message/aiReplyActivity");

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
const botReplyReference = {
  messageId: 50,
  id: botInfo.id,
  firstName: "TestBot",
  lastName: "",
  username: "test_bot",
  text: "机器人之前说的话",
};
const selfReplyReference = {
  messageId: 30,
  id: alice.id,
  firstName: "Alice",
  lastName: "Tester",
  username: "alice_dev",
  text: "我刚才说的",
};

describe("媒体直接叫机器人", () => {
  beforeEach(() => {
    recordChatMessageMock.mockClear();
    recordChatMediaMock.mockClear();
    generateAndSendReplyMock.mockClear();
    copyMessageMock.mockClear();
    quietUntil = Date.now() + 60_000;
    aiChatEnabled = true;
    clearUserReplyTriggerTimes();
    clearAiReplyActivity();
  });

  afterAll((): void => {
    clearUserReplyTriggerTimes();
    clearAiReplyActivity();
  });

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
    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "sticker",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "",
      replyTo: botReplyReference,
      fileId: "st-file",
      fileUniqueId: "st-uid",
      width: 512,
      height: 512,
      messageId: 11,
      commentOnResolve: false,
      imageGenerationRequested: true,
      stickerFallbackText: "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      directTrigger: { reason: "reply" },
    });
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
    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 12,
      text: "（发了一枚贴纸：情绪含义 😅）",
      replyTo: botReplyReference,
    });
    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 12,
      imageGenerationRequested: true,
    });
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

    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "sticker",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "",
      fileId: "st-random",
      fileUniqueId: "st-random-uid",
      width: 512,
      height: 512,
      messageId: 23,
      commentOnResolve: true,
      imageGenerationRequested: false,
      stickerFallbackText: "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      directTrigger: undefined,
    });
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
    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "sticker",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "",
      replyTo: {
        messageId: 50,
        id: 456,
        firstName: "Bob",
        lastName: "",
        text: "机器人之前说的话",
      },
      fileId: "st-file",
      fileUniqueId: "st-uid",
      width: 512,
      height: 512,
      messageId: 13,
      commentOnResolve: false,
      imageGenerationRequested: false,
      stickerFallbackText: "（发了一枚贴纸：情绪含义 😂，来自贴纸包「cool_pack」）",
      directTrigger: undefined,
    });
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("图片 caption 明确要求生图并 @ 机器人：向 Worker 传递生图授权", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 14,
        date: 1,
        chat,
        from: alice,
        caption: "帮我生成一张图 @test_bot",
        caption_entities: [{ type: "mention", offset: 8, length: 9 }],
        photo: [{ file_id: "photo-file", file_unique_id: "photo-uid", width: 640, height: 480 }],
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
      caption: "帮我生成一张图 @test_bot",
      fileId: "photo-file",
      fileUniqueId: "photo-uid",
      width: 640,
      height: 480,
      messageId: 14,
      commentOnResolve: false,
      imageGenerationRequested: true,
      directTrigger: { reason: "mention" },
    });
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("文字回复一张图片并 @ 机器人要求上色：把被回复图片作为短期参考图", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 140,
        date: 1,
        chat,
        from: alice,
        text: "@test_bot 给这张图上色",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        reply_to_message: {
          message_id: 139,
          date: 1,
          chat,
          from: { id: 456, is_bot: false, first_name: "Bob" },
          photo: [
            { file_id: "reply-photo-small", file_unique_id: "reply-photo-small-uid", width: 320, height: 240 },
            { file_id: "reply-photo-large", file_unique_id: "reply-photo-large-uid", width: 1280, height: 960 },
          ],
        },
      },
    } as any);

    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 140,
      imageGenerationRequested: true,
      imageGenerationReference: {
        fileId: "reply-photo-large",
        fileUniqueId: "reply-photo-large-uid",
        width: 1280,
        height: 960,
      },
    });
  });

  test("文字回复静态贴纸并 @ 机器人要求修图：把贴纸本体作为短期参考图", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 142,
        date: 1,
        chat,
        from: alice,
        text: "@test_bot 把这枚贴纸改成蓝色",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        reply_to_message: {
          message_id: 141,
          date: 1,
          chat,
          from: { id: 456, is_bot: false, first_name: "Bob" },
          sticker: {
            file_id: "reply-sticker-body",
            file_unique_id: "reply-sticker-uid",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "🐱",
          },
        },
      },
    } as any);

    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 142,
      imageGenerationRequested: true,
      imageGenerationReference: {
        fileId: "reply-sticker-body",
        fileUniqueId: "reply-sticker-uid",
        width: 512,
        height: 512,
      },
    });
  });

  test("GIF 回复机器人：只把缩略图交给视觉管线，缓存键仍使用 GIF 唯一 id", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 15,
        date: 1,
        chat,
        from: alice,
        reply_to_message: botReply,
        caption: "这个动图",
        animation: {
          file_id: "gif-body",
          file_unique_id: "gif-uid",
          width: 640,
          height: 360,
          duration: 2,
          thumbnail: { file_id: "gif-thumb", file_unique_id: "thumb-uid", width: 320, height: 180 },
        },
      },
    } as any);

    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "animation",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "这个动图",
      replyTo: botReplyReference,
      fileId: "gif-thumb",
      fileUniqueId: "gif-uid",
      width: 320,
      height: 180,
      messageId: 15,
      commentOnResolve: false,
      imageGenerationRequested: true,
      directTrigger: { reason: "reply" },
    });
    expect(generateAndSendReplyMock).not.toHaveBeenCalled();
  });

  test("没有缩略图的 GIF 回复机器人：记录纯文本兜底后直接触发", async () => {
    await handleIncomingMessage({
      me: botInfo,
      msg: {
        message_id: 16,
        date: 1,
        chat,
        from: alice,
        reply_to_message: botReply,
        caption: "看这个",
        animation: {
          file_id: "gif-body-only",
          file_unique_id: "gif-body-only-uid",
          width: 640,
          height: 360,
          duration: 2,
        },
      },
    } as any);

    expect(recordChatMediaMock).not.toHaveBeenCalled();
    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 16,
      text: "[GIF] 看这个",
      replyTo: botReplyReference,
    });
    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 16,
      imageGenerationRequested: true,
    });
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

    expect(recordChatMessageMock).toHaveBeenCalledWith({
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      messageId: 31,
      text: "再补充一句",
      replyTo: selfReplyReference,
    });
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

    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 32,
      isRandomTrigger: true,
      imageGenerationRequested: false,
    });
  });

  test("冷群首条使用 1/174 动态概率，不再沿用旧固定概率", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    // 0.01 低于旧固定 1/10，但高于冷群首条 1/174；也恰好不小于 1/100 随机复读。
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

  test("AI 模式开启时关闭随机复读，关闭后恢复", async () => {
    quietUntil = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 38,
          date: 1,
          chat,
          from: alice,
          document: { file_id: "ai-on-doc", file_unique_id: "ai-on-doc-uid" },
        },
      } as any);
      expect(copyMessageMock).not.toHaveBeenCalled();

      aiChatEnabled = false;
      await handleIncomingMessage({
        me: botInfo,
        msg: {
          message_id: 39,
          date: 1,
          chat,
          from: alice,
          document: { file_id: "ai-off-doc", file_unique_id: "ai-off-doc-uid" },
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(copyMessageMock).toHaveBeenCalledTimes(1);
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

    expect(recordChatMediaMock).toHaveBeenCalledWith({
      kind: "photo",
      chatId: -100800,
      senderId: 123,
      firstName: "Alice",
      lastName: "Tester",
      username: "alice_dev",
      caption: "补一张图",
      replyTo: selfReplyReference,
      fileId: "self-photo",
      fileUniqueId: "self-photo-uid",
      width: 640,
      height: 480,
      messageId: 35,
      commentOnResolve: false,
      imageGenerationRequested: false,
      directTrigger: undefined,
    });
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
          text: "找你 @test_bot",
          entities: [{ type: "mention", offset: 3, length: 9 }],
        },
      } as any);
    } finally {
      Math.random = originalRandom;
    }

    expect(generateAndSendReplyMock).toHaveBeenCalledTimes(1);
    expect(generateAndSendReplyMock).toHaveBeenCalledWith({
      chatId: -100800,
      triggerSenderId: 123,
      replyToMessageId: 34,
      imageGenerationRequested: true,
    });
  });
});
