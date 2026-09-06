import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { AiRecordMediaMessage } from "../../../packages/types/aiChat/protocol";
import type { MediaCommentContext, ReplyPromptSections, ReplyToolset } from "../../../packages/types/aiChat/replies";
import type { TelegramSendResult } from "../../../packages/types/telegram";
import type { UserContentOptions } from "../../../packages/workers/aiChat/promptContext";
import { REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../../../packages/consts/aiChat/rateLimit";

const sent: string[] = [];
const models = new Map<number, PromiseWithResolvers<string | null>>();
const toolsets = new Map<number, ReplyToolset>();
const contexts = new Map<number, UserContentOptions>();
const sendMessage = mock(async (params: { text: string }): Promise<TelegramSendResult> => {
  sent.push(params.text);
  return { messageId: sent.length };
});
const describeMedia = mock(async (): Promise<string | null> => "图片描述");
const logError = mock((..._args: unknown[]): void => {});
const realTelegram = await import("../../../packages/infra/telegram");
const realStickers = await import("../../../packages/aiChat/ai/tools/stickers");
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendMessageWithResult: sendMessage }));
mock.module("../../../packages/aiChat/ai/tools/stickers", () => ({
  ...realStickers,
  buildStickerPackMenu: async () => [],
}));
mock.module("../../../packages/aiChat/ai/chatActionHeartbeat", () => ({
  startChatActionHeartbeat: () => ({
    current: () => "idle", set: (): void => {},
    settle: async (): Promise<void> => {}, stop: async (): Promise<void> => {},
  }),
}));
mock.module("../../../packages/libs/sleep", () => ({ sleep: async (): Promise<void> => {} }));
mock.module("../../../packages/aiChat/ai/imageDescription", () => ({ describeMedia }));
mock.module("../../../packages/workers/aiChat/rollingMemory", () => ({
  recordChatMessage: (): void => {}, pushBufferedMessage: (): void => {},
}));
mock.module("../../../packages/workers/aiChat/promptContext", () => ({
  buildReplyPromptSections: (_chat: number, _self: unknown, options: UserContentOptions): ReplyPromptSections => {
    contexts.set(options.triggerMessageId, options);
    return { referenceMemory: "", currentConversation: "", replyTask: String(options.triggerMessageId) };
  },
}));
mock.module("../../../packages/workers/aiChat/replyModel", () => ({
  generateReply: (_chat: number, sections: ReplyPromptSections, toolset: ReplyToolset): Promise<string | null> => {
    const id: number = Number(sections.replyTask);
    toolsets.set(id, toolset);
    const model = Promise.withResolvers<string | null>();
    models.set(id, model);
    return model.promise;
  },
}));
mock.module("../../../packages/infra/logger", () => ({ logger: { error: logError, info: (): void => {}, log: (): void => {} } }));

const { generateAndSendReply, invalidateChatReplies } = await import("../../../packages/workers/aiChat/replyPipeline");
const { recordChatMedia } = await import("../../../packages/workers/aiChat/mediaIngest");
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");
const {
  activeReplyCounts, pendingReplyTriggers, replyDeliveryWindows, replyGenerationTasks, resetAiChatReplyCache,
} = await import("../../../packages/cache/workers/aiChat/replies");

function trigger(id: number, options: { chatId?: number; telegramBackpressured?: boolean; mediaPreparation?: Promise<MediaCommentContext | null> } = {}): void {
  generateAndSendReply({
    chatId: options.chatId ?? -1001, triggerSenderId: 7, replyToMessageId: id,
    messageThreadId: undefined, imageGenerationRequested: false, isRandomTrigger: false,
    telegramBackpressured: options.telegramBackpressured, mediaPreparation: options.mediaPreparation,
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt: number = 0; attempt < 200 && !predicate(); attempt++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

async function settleTasks(): Promise<void> {
  while (replyGenerationTasks.size > 0) {
    for (const tasks of replyGenerationTasks.values()) await Promise.allSettled(tasks);
  }
}

beforeEach(() => {
  resetAiChatReplyCache();
  botInfoState.current = { id: 99, first_name: "Bot", username: "bot" };
  models.clear(); toolsets.clear(); contexts.clear(); sent.length = 0;
  describeMedia.mockReset().mockResolvedValue("图片描述");
  sendMessage.mockClear(); logError.mockClear();
  spyOn(Math, "random").mockReturnValue(1);
});

afterEach(async () => {
  for (const model of models.values()) model.resolve(null);
  // 未开始的模型在失效时直接丢弃，已开始模型的信号同步取消。
  const invalidated = invalidateChatReplies(-1001);
  const other = invalidateChatReplies(-1002);
  await Promise.allSettled([invalidated, other]);
  await settleTasks();
  resetAiChatReplyCache(); botInfoState.current = null;
  mock.restore();
});

test("模型按 3、1、2 完成，整轮回复仍严格按入站 1、2、3 出站", async () => {
  for (let i: number = 1; i <= 3; i++) trigger(i);
  await waitUntil(() => models.size === 3);
  for (const id of [3, 1, 2]) {
    const toolset = toolsets.get(id)!;
    expect(JSON.parse(await toolset.execute("send_message", JSON.stringify({ text: `${id}a` }))).queued).toBe(true);
    expect(JSON.parse(await toolset.execute("send_message", JSON.stringify({ text: `${id}b` }))).queued).toBe(true);
  }
  expect(sent).toEqual([]);
  models.get(3)!.resolve(null);
  await Bun.sleep(1);
  expect(sent).toEqual([]);
  models.get(1)!.resolve(null);
  await waitUntil(() => sent.length === 2);
  expect(sent).toEqual(["1a", "1b"]);
  models.get(2)!.resolve(null);
  await settleTasks();
  expect(sent).toEqual(["1a", "1b", "2a", "2b", "3a", "3b"]);
  expect(replyDeliveryWindows.size).toBe(0);
  expect(activeReplyCounts.size).toBe(0);
});

test("首条发送挂起时仍逐个补跑 15 条待处理请求，完整链不占模型位", async () => {
  const pending = Promise.withResolvers<TelegramSendResult>();
  sendMessage.mockImplementationOnce((params) => { sent.push(params.text); return pending.promise; });
  const total: number = REPLY_ROUND_MAX_CONCURRENT + REPLY_TRIGGER_QUEUE_MAX;
  for (let i: number = 1; i <= total; i++) trigger(i);
  try {
    await waitUntil(() => models.size === REPLY_ROUND_MAX_CONCURRENT);
    const window = replyDeliveryWindows.get(-1001)!;
    expect(window.slots).toHaveLength(REPLY_ROUND_MAX_CONCURRENT);
    expect(pendingReplyTriggers.get(-1001)?.size).toBe(REPLY_TRIGGER_QUEUE_MAX);
    expect(pendingReplyTriggers.get(-1001)?.peek()?.replyToMessageId).toBe(REPLY_ROUND_MAX_CONCURRENT + 1);
    for (let i: number = 1; i <= total; i++) {
      await waitUntil(() => models.has(i));
      models.get(i)!.resolve(`回复${i}`);
      if (i <= REPLY_TRIGGER_QUEUE_MAX) {
        await waitUntil(() => models.has(i + REPLY_ROUND_MAX_CONCURRENT));
        expect(activeReplyCounts.get(-1001)).toBe(REPLY_ROUND_MAX_CONCURRENT);
        expect(pendingReplyTriggers.get(-1001)?.size ?? 0).toBe(REPLY_TRIGGER_QUEUE_MAX - i);
      }
    }
    await waitUntil(() => !activeReplyCounts.has(-1001));
    expect(pendingReplyTriggers.has(-1001)).toBe(false);
    expect(window.size).toBe(total);
    expect(sent).toEqual(["回复1"]);
    expect([...replyGenerationTasks.values()][0]?.size).toBe(total);
    trigger(total + 1);
    await waitUntil(() => models.has(total + 1));
    models.get(total + 1)!.resolve(`回复${total + 1}`);
    await waitUntil(() => !activeReplyCounts.has(-1001));
    expect(window.slots).toHaveLength(REPLY_ROUND_MAX_CONCURRENT);
    expect(window.size).toBe(total + 1);
    pending.resolve({ messageId: 1 });
    await settleTasks();
    expect(sent).toEqual(Array.from({ length: total + 1 }, (_, i) => `回复${i + 1}`));
    expect(replyDeliveryWindows.size).toBe(0);
  } finally {
    pending.resolve({ messageId: 1 });
  }
});

test("媒体入站先占位；后到文字已生成也等待媒体识别与回复", async () => {
  const description = Promise.withResolvers<string | null>();
  describeMedia.mockImplementationOnce(() => description.promise);
  const msg: AiRecordMediaMessage = {
    type: "recordMedia", messageThreadId: 17, kind: "photo", chatId: -1001,
    senderId: 7, firstName: "Alice", lastName: "", username: undefined,
    caption: "@bot 看图", fileId: "file", fileUniqueId: "unique", width: 100, height: 100,
    messageId: 1, commentOnResolve: false, stickerFallbackText: undefined,
    voiceMime: undefined, voiceDurationSeconds: 0, directTriggerReason: "mention",
    replyTo: undefined, forwardedFrom: undefined, persistImmediately: false,
  };
  recordChatMedia(msg);
  expect(activeReplyCounts.get(-1001)).toBe(1);
  trigger(2);
  try {
    await waitUntil(() => models.has(2));
    models.get(2)!.resolve("回复2");
    await Bun.sleep(1);
    expect(sent).toEqual([]);
    description.resolve("猫在睡觉");
    await waitUntil(() => models.has(1));
    expect(contexts.get(1)?.mediaComment?.description).toBe("猫在睡觉");
    models.get(1)!.resolve("回复1");
    await settleTasks();
    expect(sent).toEqual(["回复1", "回复2"]);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({ messageThreadId: 17 });
  } finally {
    description.resolve(null);
  }
});

test("失败和空回复都能跳过占位，其他群不等待本群", async () => {
  trigger(1); trigger(2); trigger(3); trigger(4, { chatId: -1002 });
  await waitUntil(() => models.size === 4);
  models.get(3)!.resolve("回复3");
  models.get(2)!.resolve(null);
  models.get(4)!.resolve("其他群");
  await waitUntil(() => sent.length === 1);
  expect(sent).toEqual(["其他群"]);
  models.get(1)!.reject(new Error("model failed"));
  await settleTasks();
  expect(sent).toEqual(["其他群", "回复3"]);
  expect(activeReplyCounts.size).toBe(0);
});

test("取消能释放仍在等媒体的占位和已就绪链，旧代不能占住新请求", async () => {
  const preparation = Promise.withResolvers<MediaCommentContext | null>();
  trigger(1, { mediaPreparation: preparation.promise });
  trigger(2);
  await waitUntil(() => models.has(2));
  models.get(2)!.resolve("旧回复");
  await invalidateChatReplies(-1001);
  expect(sent).toEqual([]);
  expect(activeReplyCounts.size).toBe(0);
  expect(replyDeliveryWindows.size).toBe(0);
  trigger(3);
  await waitUntil(() => models.has(3));
  models.get(3)!.resolve("新回复");
  preparation.resolve(null);
  await settleTasks();
  expect(sent).toEqual(["新回复"]);
});

test.each([false, true])("待处理队列上限仍为 15，模型并发遵守高压标记 %s", async (telegramBackpressured) => {
  const maxConcurrent: number = telegramBackpressured ? 1 : REPLY_ROUND_MAX_CONCURRENT;
  for (let i: number = 1; i <= maxConcurrent + REPLY_TRIGGER_QUEUE_MAX + 10; i++) trigger(i, { telegramBackpressured });
  await waitUntil(() => models.size === maxConcurrent);
  expect(activeReplyCounts.get(-1001)).toBe(maxConcurrent);
  expect(pendingReplyTriggers.get(-1001)?.size).toBe(REPLY_TRIGGER_QUEUE_MAX);
  expect(pendingReplyTriggers.get(-1001)?.peek()?.replyToMessageId).toBe(maxConcurrent + 1);
  expect(pendingReplyTriggers.get(-1001)?.peekLast()?.replyToMessageId).toBe(maxConcurrent + REPLY_TRIGGER_QUEUE_MAX);
  expect(replyDeliveryWindows.get(-1001)?.size).toBe(maxConcurrent);
});

test("排队媒体仍先于后到文字，补跑使用解析正文和入站快照", async () => {
  const preparation = Promise.withResolvers<MediaCommentContext | null>();
  for (let i: number = 1; i <= REPLY_ROUND_MAX_CONCURRENT; i++) trigger(i);
  const mediaId: number = REPLY_ROUND_MAX_CONCURRENT + 1;
  const textId: number = mediaId + 1;
  const media: MediaCommentContext = {
    kind: "photo", senderId: 7, senderName: "Alice", description: "",
    triggerText: "占位", directTriggerReason: "mention", forwardedFrom: "来源频道",
  };
  generateAndSendReply({
    chatId: -1001, triggerSenderId: 7, replyToMessageId: mediaId, messageThreadId: 17,
    imageGenerationRequested: false, isRandomTrigger: false, mediaComment: media,
    mediaPreparation: preparation.promise,
  });
  trigger(textId);
  await waitUntil(() => models.size === REPLY_ROUND_MAX_CONCURRENT);
  for (const model of models.values()) model.resolve(null);
  try {
    await waitUntil(() => models.has(textId));
    models.get(textId)!.resolve("后到文字");
    await Bun.sleep(1);
    expect(sent).toEqual([]);
    preparation.resolve({ ...media, description: "猫", triggerText: "[图片：猫] @bot 看看" });
    await waitUntil(() => models.has(mediaId));
    expect(contexts.get(mediaId)?.queuedTrigger).toMatchObject({
      text: "[图片：猫] @bot 看看", forwardedFrom: "来源频道", messageThreadId: 17,
    });
    models.get(mediaId)!.resolve("媒体回复");
    await settleTasks();
    expect(sent).toEqual(["媒体回复", "后到文字"]);
  } finally {
    preparation.resolve(null);
  }
});
