import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AI_REPLY_ACTIVITY_MAX_CHATS,
  AI_REPLY_ACTIVITY_MAX_TIMESTAMPS,
  AI_REPLY_ACTIVITY_WINDOW_MS,
  AI_REPLY_PROBABILITY_BASE_INITIAL,
  AI_REPLY_PROBABILITY_BASE_MIN,
} from "../../packages/consts/aiChat/rateLimit";
import { aiReplyActivityByChat } from "../../packages/cache/main/auto";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
  sweepAiReplyActivity,
} from "../../packages/auto/message/aiReplyActivity";

beforeEach(clearAiReplyActivity);
afterAll(clearAiReplyActivity);

describe("按群 AI 随机搭话活跃度", () => {
  test("当前消息先计数：冷群从初始闸门起步，同群逐条升温，不同群互不影响", () => {
    const firstMessageProbability: number = 1 / (AI_REPLY_PROBABILITY_BASE_INITIAL - 1);
    const secondMessageProbability: number = 1 / (AI_REPLY_PROBABILITY_BASE_INITIAL - 2);
    expect(observeGroupMessageForAiReply(-1001, 1_000)).toBe(firstMessageProbability);
    expect(observeGroupMessageForAiReply(-1001, 2_000)).toBe(secondMessageProbability);
    expect(observeGroupMessageForAiReply(-2002, 2_000)).toBe(firstMessageProbability);
  });

  test("一小时滑动边界精确淘汰旧消息", () => {
    const firstMessageProbability: number = 1 / (AI_REPLY_PROBABILITY_BASE_INITIAL - 1);
    const secondMessageProbability: number = 1 / (AI_REPLY_PROBABILITY_BASE_INITIAL - 2);
    expect(observeGroupMessageForAiReply(-1001, 0)).toBe(firstMessageProbability);
    expect(observeGroupMessageForAiReply(-1001, AI_REPLY_ACTIVITY_WINDOW_MS - 1)).toBe(secondMessageProbability);

    clearAiReplyActivity();
    expect(observeGroupMessageForAiReply(-1001, 0)).toBe(firstMessageProbability);
    expect(observeGroupMessageForAiReply(-1001, AI_REPLY_ACTIVITY_WINDOW_MS)).toBe(firstMessageProbability);
  });

  test("达到热群概率下限后不再提高，时间戳队列也不再增长", () => {
    let probability: number = 0;
    for (let i = 0; i < AI_REPLY_ACTIVITY_MAX_TIMESTAMPS + 20; i++) {
      probability = observeGroupMessageForAiReply(-1001, i);
    }
    expect(probability).toBe(1 / AI_REPLY_PROBABILITY_BASE_MIN);
    expect(aiReplyActivityByChat.get(-1001)?.timestamps.size).toBe(AI_REPLY_ACTIVITY_MAX_TIMESTAMPS);
  });

  test("统一 sweeper 删除空闲满一小时的群，仍活跃的群继续保留", () => {
    observeGroupMessageForAiReply(-1001, 0);
    observeGroupMessageForAiReply(-2002, 500);

    sweepAiReplyActivity(AI_REPLY_ACTIVITY_WINDOW_MS);
    expect(aiReplyActivityByChat.has(-1001)).toBe(false);
    expect(aiReplyActivityByChat.has(-2002)).toBe(true);

    sweepAiReplyActivity(AI_REPLY_ACTIVITY_WINDOW_MS + 500);
    expect(aiReplyActivityByChat.size).toBe(0);
  });

  test("群数达到硬顶后按 LRU 淘汰，活跃度表不会随历史群数无限增长", () => {
    for (let chatId = 1; chatId <= AI_REPLY_ACTIVITY_MAX_CHATS; chatId++) {
      observeGroupMessageForAiReply(chatId, 1_000);
    }
    observeGroupMessageForAiReply(1, 2_000);
    observeGroupMessageForAiReply(AI_REPLY_ACTIVITY_MAX_CHATS + 1, 2_000);

    expect(aiReplyActivityByChat.size).toBe(AI_REPLY_ACTIVITY_MAX_CHATS);
    expect(aiReplyActivityByChat.has(1)).toBe(true);
    expect(aiReplyActivityByChat.has(2)).toBe(false);
  });

  test("相同毫秒内再次访问仍刷新严格 LRU 次序", () => {
    for (let chatId = 1; chatId <= AI_REPLY_ACTIVITY_MAX_CHATS; chatId++) {
      observeGroupMessageForAiReply(chatId, 1_000);
    }
    observeGroupMessageForAiReply(1, 1_000);
    observeGroupMessageForAiReply(AI_REPLY_ACTIVITY_MAX_CHATS + 1, 1_000);

    expect(aiReplyActivityByChat.has(1)).toBe(true);
    expect(aiReplyActivityByChat.has(2)).toBe(false);
  });

  test("单群时钟回退不影响其 LRU 热度刷新", () => {
    for (let chatId = 1; chatId <= AI_REPLY_ACTIVITY_MAX_CHATS; chatId++) {
      observeGroupMessageForAiReply(chatId, 1_000);
    }
    observeGroupMessageForAiReply(1, 0);
    observeGroupMessageForAiReply(AI_REPLY_ACTIVITY_MAX_CHATS + 1, 2_000);

    expect(aiReplyActivityByChat.has(1)).toBe(true);
    expect(aiReplyActivityByChat.has(2)).toBe(false);
    expect(aiReplyActivityByChat.get(1)?.lastObservedAt).toBe(1_000);
  });
});
