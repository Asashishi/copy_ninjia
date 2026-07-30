import { afterEach, describe, expect, test } from "bun:test";
import {
  activeReplyCounts,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
  rateLimitNoticeTimes,
  replyGenerations,
  sweepAiChatReplyCache,
} from "../../../packages/cache/workers/aiChat/replies";
import { RATE_LIMIT_LONG_WINDOW_MS, RATE_LIMIT_NOTICE_COOLDOWN_MS } from "../../../packages/consts/aiChat";
import { typingHeartbeats } from "../../../packages/cache/workers/aiChat/heartbeat";
import { resetAiChatWorkerCache } from "../../../packages/cache/workers/aiChat/index";
import { botInfoState } from "../../../packages/cache/workers/aiChat/identity";
import { chatBuffers, chatLastActivityTimes, dirtyMemoryChats } from "../../../packages/cache/workers/aiChat/memory";
import { chatMoodExpiresAts, chatMoods } from "../../../packages/cache/workers/aiChat/mood";
import { compactionChains, compactionPendingCounts } from "../../../packages/cache/workers/aiChat/compaction";
import { LinkedQueue } from "../../../packages/libs/linkedQueue";
import type { BufferedMessage, ChatActionHeartbeatEntry, QueuedReplyTrigger } from "../../../packages/types";
import {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "../../../packages/workers/aiChat/replyState";

afterEach(() => {
  resetAiChatWorkerCache();
});

describe("AI 回复代际状态", () => {
  test("失效操作回收旧 epoch，清除排队/限频/心跳，但保留在途计数到 finally", async () => {
    const queue = new LinkedQueue<QueuedReplyTrigger>();
    queue.push({ triggerSenderId: 7, replyToMessageId: 1, imageGenerationRequested: false, senderName: "Alice", text: "hello" });
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

    await invalidateChatReplies(-1001);

    expect(replyGenerations.has(-1001)).toBe(false);
    expect(isReplyGenerationCurrent(-1001, captured)).toBe(false);
    expect(currentReplyGeneration(-1001)).not.toBe(captured);
    expect(pendingReplyTriggers.has(-1001)).toBe(false);
    expect(pendingOverflowNotices.has(-1001)).toBe(false);
    expect(longTriggerTimes.has(-1001)).toBe(false);
    expect(rateLimitNoticeTimes.has(-1001)).toBe(false);
    expect(typingHeartbeats.has(-1001)).toBe(false);
    expect(activeReplyCounts.get(-1001)).toBe(1);
  });

  test("失效先中止旧代信号，并等待该代全部 generation-sensitive 任务 settle", async () => {
    const chatId: number = -1006;
    const generation: number = currentReplyGeneration(chatId);
    const signal: AbortSignal = replyGenerationSignal(chatId, generation);
    let settleTask: (() => void) | undefined;
    const task: Promise<void> = new Promise<void>((resolve: () => void): void => {
      settleTask = resolve;
    });
    trackReplyGenerationTask(chatId, generation, task);

    let invalidationSettled: boolean = false;
    const invalidated: Promise<void> = invalidateChatReplies(chatId).then((): void => {
      invalidationSettled = true;
    });
    await Promise.resolve();

    expect(signal.aborted).toBeTrue();
    expect(invalidationSettled).toBeFalse();
    settleTask?.();
    await invalidated;
    expect(invalidationSettled).toBeTrue();
  });

  test("Worker 重建清理边界会清空所有领域缓存并停止心跳 timer", () => {
    botInfoState.current = { id: 1, username: "bot", first_name: "Bot" };
    const messages = new LinkedQueue<BufferedMessage>();
    messages.push({ messageId: 2, id: 2, firstName: "Alice", lastName: "", text: "hi", at: "" });
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

  test("时钟回拨时整体丢弃未来的长窗口与提示冷却", () => {
    const now = 1_000_000;
    const futureTimes = new LinkedQueue<number>();
    futureTimes.push(now + 1);
    futureTimes.push(now + RATE_LIMIT_LONG_WINDOW_MS * 10);
    longTriggerTimes.set(-1005, futureTimes);
    rateLimitNoticeTimes.set(-1005, now + 1);

    sweepAiChatReplyCache(now);

    expect(longTriggerTimes.has(-1005)).toBe(false);
    expect(rateLimitNoticeTimes.has(-1005)).toBe(false);
  });
});
