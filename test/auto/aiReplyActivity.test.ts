import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AI_REPLY_ACTIVITY_MAX_CHATS,
  AI_REPLY_ACTIVITY_MAX_TIMESTAMPS,
  AI_REPLY_ACTIVITY_WINDOW_MS,
} from "../../src/consts/aiChat";
import { aiReplyActivityByChat } from "../../src/cache/auto";
import {
  clearAiReplyActivity,
  observeGroupMessageForAiReply,
  sweepAiReplyActivity,
} from "../../src/auto/message/aiReplyActivity";

beforeEach(clearAiReplyActivity);
afterAll(clearAiReplyActivity);

describe("按群 AI 随机搭话活跃度", () => {
  test("当前消息先计数：冷群从 1/149 起步，同群逐条升温，不同群互不影响", () => {
    expect(observeGroupMessageForAiReply(-1001, 1_000)).toBe(1 / 149);
    expect(observeGroupMessageForAiReply(-1001, 2_000)).toBe(1 / 148);
    expect(observeGroupMessageForAiReply(-2002, 2_000)).toBe(1 / 149);
  });

  test("一小时滑动边界精确淘汰旧消息", () => {
    expect(observeGroupMessageForAiReply(-1001, 0)).toBe(1 / 149);
    expect(observeGroupMessageForAiReply(-1001, AI_REPLY_ACTIVITY_WINDOW_MS - 1)).toBe(1 / 148);

    clearAiReplyActivity();
    expect(observeGroupMessageForAiReply(-1001, 0)).toBe(1 / 149);
    expect(observeGroupMessageForAiReply(-1001, AI_REPLY_ACTIVITY_WINDOW_MS)).toBe(1 / 149);
  });

  test("达到 135 条后概率封底为 1/15，时间戳队列也不再增长", () => {
    let probability: number = 0;
    for (let i = 0; i < AI_REPLY_ACTIVITY_MAX_TIMESTAMPS + 20; i++) {
      probability = observeGroupMessageForAiReply(-1001, i);
    }
    expect(probability).toBe(1 / 15);
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
});
