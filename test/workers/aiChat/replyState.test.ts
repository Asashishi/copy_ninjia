import { afterEach, describe, expect, test } from "bun:test";
import {
  activeReplyCounts,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
  rateLimitNoticeTimes,
  sweepAiChatReplyCache,
} from "../../../src/cache/aiChat/replies";
import { RATE_LIMIT_LONG_WINDOW_MS, RATE_LIMIT_NOTICE_COOLDOWN_MS } from "../../../src/consts/aiChat";
import { typingHeartbeats } from "../../../src/cache/aiChat/heartbeat";
import { resetAiChatWorkerCache } from "../../../src/cache/aiChat/index";
import { botInfoState } from "../../../src/cache/aiChat/identity";
import { chatBuffers, chatLastActivityTimes, dirtyMemoryChats } from "../../../src/cache/aiChat/memory";
import { chatMoodExpiresAts, chatMoods } from "../../../src/cache/aiChat/mood";
import { compactionChains, compactionPendingCounts } from "../../../src/cache/aiChat/compaction";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { BufferedMessage, ChatActionHeartbeatEntry, QueuedReplyTrigger } from "../../../src/types";
import {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
} from "../../../src/workers/aiChat/replyState";

afterEach(() => {
  resetAiChatWorkerCache();
});

describe("AI 回复代际状态", () => {
  test("失效操作递增代数，清除排队/限频/心跳，但保留在途计数到 finally", () => {
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    queue.push({ replyToMessageId: 1, senderName: "Alice", text: "hello" });
    pendingReplyTriggers.set(-1001, queue);
    pendingOverflowNotices.add(-1001);
    const triggerTimes = new LinkedQueue<number>();
    triggerTimes.push(Date.now());
    longTriggerTimes.set(-1001, triggerTimes);
    rateLimitNoticeTimes.set(-1001, Date.now());
    activeReplyCounts.set(-1001, 1);
    const timer = setInterval(() => {}, 60_000);
    typingHeartbeats.set(-1001, {
      timer,
      refCount: 1,
      action: "typing",
      owner: {},
      sendChain: Promise.resolve(),
      pendingSend: false,
      pendingSendDeduplicate: true,
      lastSentPhase: "typing",
      lastSentAt: Date.now(),
      inflight: new Set(),
      consecutiveFailures: 0,
    } satisfies ChatActionHeartbeatEntry);
    const captured: number = currentReplyGeneration(-1001);

    invalidateChatReplies(-1001);

    expect(currentReplyGeneration(-1001)).toBe(captured + 1);
    expect(isReplyGenerationCurrent(-1001, captured)).toBe(false);
    expect(pendingReplyTriggers.has(-1001)).toBe(false);
    expect(pendingOverflowNotices.has(-1001)).toBe(false);
    expect(longTriggerTimes.has(-1001)).toBe(false);
    expect(rateLimitNoticeTimes.has(-1001)).toBe(false);
    expect(typingHeartbeats.has(-1001)).toBe(false);
    expect(activeReplyCounts.get(-1001)).toBe(1);
  });

  test("Worker 重建清理边界会清空所有领域缓存并停止心跳 timer", () => {
    botInfoState.current = { id: 1, username: "bot", first_name: "Bot" };
    const messages = new LinkedQueue<BufferedMessage>();
    messages.push({ id: 2, firstName: "Alice", lastName: "", text: "hi", at: "" });
    chatBuffers.set(-1002, messages);
    dirtyMemoryChats.add(-1002);
    chatMoods.set(-1002, { name: "平静", weight: 1, instruction: "保持平静" });
    chatMoodExpiresAts.set(-1002, Date.now() + 60_000);
    chatLastActivityTimes.set(-1002, Date.now());
    compactionChains.set(-1002, Promise.resolve());
    compactionPendingCounts.set(-1002, 1);
    pendingOverflowNotices.add(-1002);
    const timer = setInterval(() => {}, 60_000);
    typingHeartbeats.set(-1002, {
      timer,
      refCount: 1,
      action: "choose_sticker",
      owner: {},
      sendChain: Promise.resolve(),
      pendingSend: false,
      pendingSendDeduplicate: true,
      lastSentPhase: "choose_sticker",
      lastSentAt: Date.now(),
      inflight: new Set(),
      consecutiveFailures: 0,
    });

    resetAiChatWorkerCache();

    expect(botInfoState.current).toBeNull();
    expect(chatBuffers.size).toBe(0);
    expect(dirtyMemoryChats.size).toBe(0);
    expect(chatMoods.size).toBe(0);
    expect(chatMoodExpiresAts.size).toBe(0);
    expect(chatLastActivityTimes.size).toBe(0);
    expect(compactionChains.size).toBe(0);
    expect(compactionPendingCounts.size).toBe(0);
    expect(pendingOverflowNotices.size).toBe(0);
    expect(typingHeartbeats.size).toBe(0);
  });

  test("统一 sweeper 收掉过期限频状态并保留窗口内记录", () => {
    const now = 1_000_000;
    const expiredAndFresh = new LinkedQueue<number>();
    expiredAndFresh.push(now - RATE_LIMIT_LONG_WINDOW_MS);
    expiredAndFresh.push(now - RATE_LIMIT_LONG_WINDOW_MS + 1);
    longTriggerTimes.set(-1003, expiredAndFresh);
    const expiredOnly = new LinkedQueue<number>();
    expiredOnly.push(now - RATE_LIMIT_LONG_WINDOW_MS - 1);
    longTriggerTimes.set(-1004, expiredOnly);
    rateLimitNoticeTimes.set(-1003, now - RATE_LIMIT_NOTICE_COOLDOWN_MS + 1);
    rateLimitNoticeTimes.set(-1004, now - RATE_LIMIT_NOTICE_COOLDOWN_MS);

    sweepAiChatReplyCache(now);

    expect(longTriggerTimes.get(-1003)?.last(2)).toEqual([now - RATE_LIMIT_LONG_WINDOW_MS + 1]);
    expect(longTriggerTimes.has(-1004)).toBe(false);
    expect(rateLimitNoticeTimes.has(-1003)).toBe(true);
    expect(rateLimitNoticeTimes.has(-1004)).toBe(false);
  });
});
