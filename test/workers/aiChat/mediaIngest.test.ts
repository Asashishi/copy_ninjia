import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiRecordMediaMessage } from "../../../src/types/aiChat/protocol";
import type { StickerCatalogEntry } from "../../../src/types/stickers/catalog";

const describeMedia = mock(async (..._args: unknown[]): Promise<string | null> => "一只戴帽子的猫");
const getCatalogEntry = mock((_fileUniqueId: string): StickerCatalogEntry | undefined => undefined);
const pushBufferedMessage = mock((..._args: unknown[]): void => {});
const generateAndSendReply = mock((..._args: unknown[]): void => {});

mock.module("../../../src/ai/imageDescription", () => ({ describeMedia }));
mock.module("../../../src/ai/stickers/catalog", () => ({ getCatalogEntry }));
mock.module("../../../src/workers/aiChat/rollingMemory", () => ({ pushBufferedMessage }));
mock.module("../../../src/workers/aiChat/replyPipeline", () => ({
  currentReplyGeneration: () => 0,
  generateAndSendReply,
  isReplyGenerationCurrent: () => true,
}));

const { recordChatMedia } = await import("../../../src/workers/aiChat/mediaIngest");
const { dirtyMemoryChats } = await import("../../../src/cache/aiChat/memory");

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
    directTrigger: { reason: "mention" },
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
});

describe("AI 媒体触发的生图参考图", () => {
  test("当前图片明确触发生图时，把自身 file_id 只沿本轮触发链传递", async () => {
    recordChatMedia(photoMessage());
    await Promise.resolve();

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
      mediaComment: expect.objectContaining({ triggerText: "[图片：一只戴帽子的猫] @bot 把它画成油画" }),
    }));
    const bufferedEntry = pushBufferedMessage.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(bufferedEntry.fileId).toBeUndefined();
    expect(bufferedEntry.fileUniqueId).toBeUndefined();
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
