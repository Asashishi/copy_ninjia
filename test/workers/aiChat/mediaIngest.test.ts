import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiRecordMediaMessage } from "../../../packages/types/aiChat/protocol";
import type { StickerCatalogEntry } from "../../../packages/types/stickers/catalog";

const describeMedia = mock(async (..._args: unknown[]): Promise<string | null> => "一只戴帽子的猫");
const getCatalogEntry = mock((_fileUniqueId: string): StickerCatalogEntry | undefined => undefined);
const pushBufferedMessage = mock((..._args: unknown[]): void => {});
const generateAndSendReply = mock((..._args: unknown[]): void => {});
const trackReplyGenerationTask = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/imageDescription", () => ({ describeMedia }));
mock.module("../../../packages/aiChat/ai/stickers/catalog", () => ({ getCatalogEntry }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({ pushBufferedMessage }));
mock.module("../../../packages/workers/aiChat/replyPipeline", () => ({
  currentReplyGeneration: () => 0,
  generateAndSendReply,
  isReplyGenerationCurrent: () => true,
  trackReplyGenerationTask,
}));

const { recordChatMedia } = await import("../../../packages/workers/aiChat/mediaIngest");
const { dirtyMemoryChats } = await import("../../../packages/cache/workers/aiChat/memory");

function photoMessage(): AiRecordMediaMessage {
  return {
    type: "recordMedia",
    kind: "photo",
    chatId: -1001,
    senderId: 7,
    firstName: "Alice",
    lastName: "",
    caption: "@bot 把它画成油画",
    fileId: "current-photo",
    fileUniqueId: "current-photo-unique",
    width: 1600,
    height: 900,
    messageId: 10,
    commentOnResolve: false,
    imageGenerationRequested: true,
    stickerFallbackText: undefined,
    directTrigger: { reason: "mention" },
    username: undefined,
    replyTo: undefined,
    forwardedFrom: undefined,
    persistImmediately: false,
  };
}

function stickerMessage(): AiRecordMediaMessage {
  return {
    ...photoMessage(),
    kind: "sticker",
    caption: "",
    fileId: "sticker-vision-source",
    fileUniqueId: "sticker-unique",
  };
}

beforeEach(() => {
  dirtyMemoryChats.clear();
  describeMedia.mockClear();
  describeMedia.mockResolvedValue("一只戴帽子的猫");
  getCatalogEntry.mockClear();
  pushBufferedMessage.mockClear();
  generateAndSendReply.mockClear();
  trackReplyGenerationTask.mockClear();
});

describe("AI 媒体触发的生图参考图", () => {
  test("当前图片明确触发生图时，把自身 file_id 只沿本轮触发链传递", async () => {
    recordChatMedia({ ...photoMessage(), forwardedFrom: "频道 [id:-100666] 东京日报" });
    await Promise.resolve();

    expect(trackReplyGenerationTask).toHaveBeenCalledWith(-1001, 0, expect.any(Promise));
    expect(generateAndSendReply).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      replyToMessageId: 10,
      imageGenerationRequested: true,
      imageGenerationReference: {
        fileId: "current-photo",
        fileUniqueId: "current-photo-unique",
        width: 1600,
        height: 900,
      },
      mediaComment: expect.objectContaining({
        senderId: 7,
        triggerText: "[图片：一只戴帽子的猫] @bot 把它画成油画",
        forwardedFrom: "频道 [id:-100666] 东京日报",
        triggerReference: {
          messageId: 10,
          id: 7,
          firstName: "Alice",
          lastName: "",
          text: "[图片：一只戴帽子的猫] @bot 把它画成油画",
          forwardedFrom: "频道 [id:-100666] 东京日报",
        },
      }),
    }));
    const bufferedEntry = pushBufferedMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(bufferedEntry.messageId).toBe(10);
    expect(bufferedEntry.fileId).toBeUndefined();
    expect(bufferedEntry.fileUniqueId).toBeUndefined();
    expect(bufferedEntry.forwardedFrom).toBe("频道 [id:-100666] 东京日报");
  });

  test("贴纸的可视素材会作为本轮生图参考", async () => {
    recordChatMedia(stickerMessage());
    await Promise.resolve();

    expect(generateAndSendReply).toHaveBeenCalledWith(expect.objectContaining({
      imageGenerationRequested: true,
      imageGenerationReference: {
        fileId: "sticker-vision-source",
        fileUniqueId: "sticker-unique",
        width: 1600,
        height: 900,
      },
    }));
  });

  test("贴纸目录快速路径也保留本轮生图参考", () => {
    getCatalogEntry.mockReturnValueOnce({ emoji: "🐱", description: "一只猫向前挥爪" });

    recordChatMedia(stickerMessage());

    expect(describeMedia).not.toHaveBeenCalled();
    expect(generateAndSendReply).toHaveBeenCalledWith(expect.objectContaining({
      imageGenerationRequested: true,
      imageGenerationReference: {
        fileId: "sticker-vision-source",
        fileUniqueId: "sticker-unique",
        width: 1600,
        height: 900,
      },
    }));
  });

  test("随机媒体评价不会附带参考图", async () => {
    recordChatMedia({
      ...stickerMessage(),
      imageGenerationRequested: false,
      directTrigger: undefined,
      commentOnResolve: true,
    });
    await Promise.resolve();

    expect(generateAndSendReply).toHaveBeenCalledTimes(1);
    expect(generateAndSendReply.mock.calls[0]?.[0]).not.toHaveProperty("imageGenerationReference");
  });
});
