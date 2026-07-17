import { beforeEach, describe, expect, mock, test } from "bun:test";

/** 「拿贴纸回复机器人」的触发判定（见 src/auto/message.ts 的贴纸分支）：
 * 有视觉素材时经 recordChatMedia 带 replyToBot 走「先试缓存、解析完成再
 * 回答」的必回管线；没有素材时记完兜底行直接按回复机器人触发。storage
 * mock 里 quietUntil 恒为将来时刻——必回路径与文字回复/@ 一致地无视
 * /quiet，正好顺带验证这一点。 */

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

// 全量跑时 test/ai/stickerCatalog.test.ts 会把 pickStickerVisionSource 换成
// 恒返回素材的桩（bun 的 mock.module 是进程级注册表，跨文件生效），这里按
// 真实语义重新钉住：静态贴纸下载本体，动态/视频贴纸只有缩略图可用、没有
// 缩略图则没有素材（与 src/ai/stickerSets.ts 的实现一致）。
const realStickerSets = await import("../../src/ai/stickerSets");
mock.module("../../src/ai/stickerSets", () => ({
  ...realStickerSets,
  pickStickerVisionSource: (sticker: any) => {
    const downloadFileId: string | undefined = !sticker.is_animated && !sticker.is_video ? sticker.file_id : sticker.thumbnail?.file_id;
    if (!downloadFileId) return null;
    return { fileId: downloadFileId, fileUniqueId: sticker.file_unique_id };
  },
}));

const { handleIncomingMessage } = await import("../../src/auto/message");

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

describe("拿贴纸回复机器人", () => {
  beforeEach(() => {
    recordChatMessageMock.mockClear();
    recordChatMediaMock.mockClear();
    generateAndSendReplyMock.mockClear();
  });

  test("静态贴纸回复机器人：recordChatMedia 带上 replyToBot 与被回复文本，不掷评价骰", async () => {
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
      { repliedBotText: "机器人之前说的话" }
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

  test("贴纸回复的不是机器人：不带 replyToBot，也不触发回复", async () => {
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
});
