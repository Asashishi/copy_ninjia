import { beforeEach, describe, expect, mock, test } from "bun:test";
import { aiReplyReferenceFixture } from "../../helpers/aiMemoryFixtures";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { AiRecordMessage, RepliedBotImage } from "../../../packages/types/aiChat/protocol";

const describeMedia = mock(async (..._args: unknown[]): Promise<string | null> => "一只戴帽子的猫");
mock.module("../../../packages/aiChat/ai/imageDescription", () => ({ describeMedia }));

const {
  recordBotImage,
  repliedBotImageBackfill,
  resolveRepliedBotImage,
  trackGeneratedImage,
} = await import("../../../packages/workers/aiChat/botImages");
const { recordChatMessage } = await import("../../../packages/workers/aiChat/rollingMemory");
const { lookupBufferedMessage } = await import("../../../packages/workers/aiChat/bufferedMessageIndex");
const { resetAiChatWorkerCache } = await import("../../../packages/cache/workers/aiChat");
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");
const { dirtyMemoryChats } = await import("../../../packages/cache/workers/aiChat/memory");

const CHAT_ID: number = -1001;
const BOT_ID: number = 4242;
const PHOTO: RepliedBotImage = { fileId: "bot-photo", fileUniqueId: "bot-photo-u", caption: "Alice，你的群友老婆是 Bob!" };

/** 一条回复了机器人图片的群友文字记录；被回复消息的正文是主线程给的类型占位。 */
function replyRecord(messageId: number, repliedToMessageId: number): AiRecordMessage {
  return {
    type: "record",
    chatId: CHAT_ID,
    senderId: 7,
    firstName: "Alice",
    lastName: "",
    username: undefined,
    messageId,
    replyTo: aiReplyReferenceFixture({
      messageId: repliedToMessageId,
      id: BOT_ID,
      text: `[图片] ${PHOTO.caption}`,
      botImage: PHOTO,
    }),
    forwardedFrom: undefined,
    persistImmediately: false,
    text: "这是谁",
  };
}

/** 记录一条回复并按 Worker 分派的顺序解析它回复的机器人图片。 */
function recordReply(messageId: number, repliedToMessageId: number): BufferedMessage {
  const record: AiRecordMessage = replyRecord(messageId, repliedToMessageId);
  const entry: BufferedMessage = recordChatMessage(record)!;
  resolveRepliedBotImage(CHAT_ID, entry, record.replyTo!.botImage!);
  return entry;
}

beforeEach(() => {
  resetAiChatWorkerCache();
  botInfoState.current = { id: BOT_ID, username: "tensai_bot", first_name: "Tensai" };
  describeMedia.mockClear();
  describeMedia.mockResolvedValue("一只戴帽子的猫");
});

describe("命令图片的占位自录", () => {
  test("新发出的图片以占位态写入热区，不识图", () => {
    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 50, caption: "第一行\n第二行", edited: false, persistImmediately: false });

    const entry: BufferedMessage | undefined = lookupBufferedMessage(CHAT_ID, 50);
    expect(entry?.id).toBe(BOT_ID);
    expect(entry?.text).toBe("（发送了一张图片）第一行 第二行");
    expect(entry?.pendingImage).toEqual({ origin: "command", caption: "第一行 第二行" });
    expect(describeMedia).not.toHaveBeenCalled();
  });

  test("换图只把仍在热区的原条目重置为占位态，不新增条目", async () => {
    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 50, caption: "旧图注", edited: false, persistImmediately: false });
    recordReply(51, 50);
    await repliedBotImageBackfill(CHAT_ID, 51);
    expect(lookupBufferedMessage(CHAT_ID, 50)?.pendingImage).toBeUndefined();

    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 50, caption: "新图注", edited: true, persistImmediately: false });
    expect(lookupBufferedMessage(CHAT_ID, 50)?.text).toBe("（发送了一张图片）新图注");
    expect(lookupBufferedMessage(CHAT_ID, 50)?.pendingImage).toEqual({ origin: "command", caption: "新图注" });

    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 60, caption: "不在热区", edited: true, persistImmediately: false });
    expect(lookupBufferedMessage(CHAT_ID, 60)).toBeUndefined();
  });

  test("旧图识图途中换了图，迟到的旧描述不写进新图的条目", async () => {
    const oldDescription: PromiseWithResolvers<string | null> = Promise.withResolvers<string | null>();
    describeMedia.mockImplementationOnce((): Promise<string | null> => oldDescription.promise);
    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 50, caption: "旧图注", edited: false, persistImmediately: false });
    const reply: BufferedMessage = recordReply(51, 50);

    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 50, caption: "新图注", edited: true, persistImmediately: false });
    oldDescription.resolve("旧图里的人");
    await repliedBotImageBackfill(CHAT_ID, 51);

    expect(lookupBufferedMessage(CHAT_ID, 50)?.text).toBe("（发送了一张图片）新图注");
    expect(lookupBufferedMessage(CHAT_ID, 50)?.pendingImage).toEqual({ origin: "command", caption: "新图注" });
    // 这条回复针对的是旧图，引用按旧图的图注拼描述。
    expect(reply.replyTo?.text).toBe(`（发送了一张图片：旧图里的人）${PHOTO.caption}`);
  });
});

describe("生图落地即识图", () => {
  test("占位态的提示词记录在识图完成后原位换成画面内容", async () => {
    const entry: BufferedMessage = recordChatMessage({
      type: "record", chatId: CHAT_ID, senderId: BOT_ID, firstName: "自己（也就是你）", lastName: "",
      username: undefined, messageId: 70, replyTo: undefined, forwardedFrom: undefined,
      persistImmediately: false, text: "（参考素材生成并发送了一张图片：油画风的猫）给你",
    })!;
    trackGeneratedImage({
      chatId: CHAT_ID,
      entry,
      origin: "referenceGenerated",
      caption: "给你",
      photo: { fileId: "generated", fileUniqueId: "generated-u", width: 1024, height: 1024 },
    });
    expect(entry.pendingImage).toEqual({ origin: "referenceGenerated", caption: "给你" });
    dirtyMemoryChats.clear();

    await Bun.sleep(0);
    expect(describeMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: "photo", fileId: "generated", fileUniqueId: "generated-u" }));
    expect(entry.text).toBe("（参考素材生成并发送了一张图片：一只戴帽子的猫）给你");
    expect(entry.pendingImage).toBeUndefined();
    expect(dirtyMemoryChats.has(CHAT_ID)).toBe(true);
  });

  test("识图失败时保留提示词与占位态，下次被回复时重试", async () => {
    describeMedia.mockResolvedValueOnce(null);
    const entry: BufferedMessage = recordChatMessage({
      type: "record", chatId: CHAT_ID, senderId: BOT_ID, firstName: "自己（也就是你）", lastName: "",
      username: undefined, messageId: 70, replyTo: undefined, forwardedFrom: undefined,
      persistImmediately: false, text: "（生成并发送了一张图片：油画风的猫）",
    })!;
    trackGeneratedImage({
      chatId: CHAT_ID, entry, origin: "generated", caption: "",
      photo: { fileId: "generated", fileUniqueId: "generated-u", width: 1024, height: 1024 },
    });
    await Bun.sleep(0);
    expect(entry.text).toBe("（生成并发送了一张图片：油画风的猫）");
    expect(entry.pendingImage).toEqual({ origin: "generated", caption: "" });

    const reply: BufferedMessage = recordReply(71, 70);
    await repliedBotImageBackfill(CHAT_ID, 71);
    expect(describeMedia).toHaveBeenCalledTimes(2);
    expect(entry.text).toBe("（生成并发送了一张图片：一只戴帽子的猫）");
    expect(reply.replyTo?.text).toBe("（生成并发送了一张图片：一只戴帽子的猫）");
  });
});

describe("回复机器人图片", () => {
  test("被回复的图已有内容时直接复用正文，不再识图", () => {
    recordChatMessage({
      type: "record", chatId: CHAT_ID, senderId: BOT_ID, firstName: "自己（也就是你）", lastName: "",
      username: undefined, messageId: 80, replyTo: undefined, forwardedFrom: undefined,
      persistImmediately: false, text: "（生成并发送了一张图片：夜空）",
    });

    const reply: BufferedMessage = recordReply(81, 80);
    expect(reply.replyTo?.text).toBe("（生成并发送了一张图片：夜空）");
    expect(describeMedia).not.toHaveBeenCalled();
    expect(repliedBotImageBackfill(CHAT_ID, 81)).toBeUndefined();
  });

  test("占位态的命令图被回复时识图，回填原条目与回复引用，之后再回复不重复识图", async () => {
    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 90, caption: PHOTO.caption, edited: false, persistImmediately: false });

    const first: BufferedMessage = recordReply(91, 90);
    expect(first.replyTo?.text).toBe(`[图片] ${PHOTO.caption}`);
    const backfill: Promise<void> | undefined = repliedBotImageBackfill(CHAT_ID, 91);
    expect(backfill).toBeInstanceOf(Promise);
    await backfill;

    const expected: string = `（发送了一张图片：一只戴帽子的猫）${PHOTO.caption}`;
    expect(describeMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: "photo", fileId: "bot-photo", fileUniqueId: "bot-photo-u" }));
    expect(lookupBufferedMessage(CHAT_ID, 90)?.text).toBe(expected);
    expect(lookupBufferedMessage(CHAT_ID, 90)?.pendingImage).toBeUndefined();
    expect(first.replyTo?.text).toBe(expected);
    expect(repliedBotImageBackfill(CHAT_ID, 91)).toBeUndefined();

    const second: BufferedMessage = recordReply(92, 90);
    expect(second.replyTo?.text).toBe(expected);
    expect(describeMedia).toHaveBeenCalledTimes(1);
  });

  test("被回复的图不在热区时识图，只改写本条回复引用", async () => {
    const reply: BufferedMessage = recordReply(101, 12);
    await repliedBotImageBackfill(CHAT_ID, 101);

    expect(lookupBufferedMessage(CHAT_ID, 12)).toBeUndefined();
    expect(reply.replyTo?.text).toBe(`（发送了一张图片：一只戴帽子的猫）${PHOTO.caption}`);
  });

  test("识图失败时回复引用保留主线程的类型占位，原条目保持占位态", async () => {
    describeMedia.mockResolvedValueOnce(null);
    recordBotImage({ type: "recordBotImage", chatId: CHAT_ID, messageId: 110, caption: "", edited: false, persistImmediately: false });

    const reply: BufferedMessage = recordReply(111, 110);
    await repliedBotImageBackfill(CHAT_ID, 111);

    expect(reply.replyTo?.text).toBe(`[图片] ${PHOTO.caption}`);
    expect(lookupBufferedMessage(CHAT_ID, 110)?.text).toBe("（发送了一张图片）");
    expect(lookupBufferedMessage(CHAT_ID, 110)?.pendingImage).toEqual({ origin: "command", caption: "" });
  });
});
