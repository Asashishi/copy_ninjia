import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiRecordMediaMessage } from "../../../packages/types/aiChat/protocol";
import type { GenerateAndSendReplyParams } from "../../../packages/workers/aiChat/replyPipeline";
import type { StickerCatalogEntry } from "../../../packages/types/stickers/catalog";

const describeMedia = mock(async (..._args: unknown[]): Promise<string | null> => "一只戴帽子的猫");
const getCatalogEntry = mock((_fileUniqueId: string): StickerCatalogEntry | undefined => undefined);
const pushBufferedMessage = mock((..._args: unknown[]): void => {});
const generateAndSendReply = mock((..._args: unknown[]): void => {});
const trackReplyGenerationTask = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/imageDescription", () => ({ describeMedia }));
mock.module("../../../packages/aiChat/ai/stickers/catalog", () => ({ getCatalogEntry }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({ pushBufferedMessage }));
mock.module("../../../packages/workers/aiChat/replyPipeline", () => ({ generateAndSendReply }));
mock.module("../../../packages/workers/aiChat/replyGeneration", () => ({
  replyGenerationSignal: (): AbortSignal => new AbortController().signal,
  trackReplyGenerationTask,
}));

const { recordChatMedia } = await import("../../../packages/workers/aiChat/mediaIngest");
const { dirtyMemoryChats } = await import("../../../packages/cache/workers/aiChat/memory");
const { cachedReplyGeneration } = await import("../../../packages/cache/workers/aiChat/replies");

function photoMessage(): AiRecordMediaMessage {
  return {
    type: "recordMedia",
    messageThreadId: undefined,
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
    replyTelegramBackpressured: false,
    stickerFallbackText: undefined,
    voiceMime: undefined,
    voiceDurationSeconds: 0,
    directTriggerReason: "mention",
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
    const generation: number = cachedReplyGeneration(-1001);
    recordChatMedia({ ...photoMessage(), forwardedFrom: "频道 [id:-100666] 东京日报" });
    await Promise.resolve();

    expect(trackReplyGenerationTask).toHaveBeenCalledWith(-1001, generation, expect.any(Promise));
    expect(generateAndSendReply).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -1001,
      replyToMessageId: 10,
      imageGenerationReference: {
        fileId: "current-photo",
        fileUniqueId: "current-photo-unique",
        width: 1600,
        height: 900,
      },
      mediaPreparation: expect.any(Promise),
    }));
    const params = generateAndSendReply.mock.calls[0]![0] as GenerateAndSendReplyParams;
    expect(await params.mediaPreparation).toMatchObject({
      senderId: 7,
      triggerText: "[图片：一只戴帽子的猫] @bot 把它画成油画",
      forwardedFrom: "频道 [id:-100666] 东京日报",
      triggerReference: {
        messageId: 10, id: 7, firstName: "Alice", lastName: "",
        text: "[图片：一只戴帽子的猫] @bot 把它画成油画",
        forwardedFrom: "频道 [id:-100666] 东京日报",
      },
    });
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
      directTriggerReason: undefined,
      replyTelegramBackpressured: false,
    });
    await Promise.resolve();

    expect(generateAndSendReply).toHaveBeenCalledTimes(1);
    expect(generateAndSendReply.mock.calls[0]?.[0]).not.toHaveProperty("imageGenerationReference");
  });

  test("识别开始前已准入占位，直接触发失败提供兜底，随机评价失败完成空占位", async () => {
    describeMedia.mockImplementationOnce(async (): Promise<null> => {
      expect(generateAndSendReply).toHaveBeenCalledTimes(1);
      return null;
    });
    recordChatMedia(photoMessage());
    const direct = generateAndSendReply.mock.calls[0]![0] as GenerateAndSendReplyParams;
    expect(await direct.mediaPreparation).toMatchObject({ directTriggerReason: "mention" });
    expect((await direct.mediaPreparation)?.description).not.toBe("");
    describeMedia.mockResolvedValueOnce(null);
    recordChatMedia({ ...photoMessage(), directTriggerReason: undefined, replyTelegramBackpressured: false });
    const random = generateAndSendReply.mock.calls[1]![0] as GenerateAndSendReplyParams;
    expect(await random.mediaPreparation).toBeNull();
  });
});

describe("AI 媒体触发的 Telegram 背压快照", () => {
  test.each([false, true])("直接触发（含贴纸目录快路径）与随机评价都把随媒体投递的快照 %s 交给准入", (replyTelegramBackpressured) => {
    getCatalogEntry.mockReturnValueOnce({ emoji: "🐱", description: "一只猫向前挥爪" });
    recordChatMedia({ ...stickerMessage(), replyTelegramBackpressured });
    recordChatMedia({ ...photoMessage(), replyTelegramBackpressured });
    recordChatMedia({ ...photoMessage(), directTriggerReason: undefined, replyTelegramBackpressured });

    expect(generateAndSendReply).toHaveBeenCalledTimes(3);
    for (const [params] of generateAndSendReply.mock.calls) {
      expect(params).toMatchObject({ isRandomTrigger: false, telegramBackpressured: replyTelegramBackpressured });
    }
    expect(pushBufferedMessage).toHaveBeenCalledTimes(3);
  });

  test("不发起回复的媒体只记进上下文并照常解析，不进入准入", async () => {
    recordChatMedia({ ...photoMessage(), directTriggerReason: undefined, replyTelegramBackpressured: undefined });
    await Promise.resolve();

    expect(pushBufferedMessage).toHaveBeenCalledTimes(1);
    expect(describeMedia).toHaveBeenCalledTimes(1);
    expect(generateAndSendReply).not.toHaveBeenCalled();
  });
});
