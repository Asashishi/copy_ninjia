import {
  AI_REPLY_ACTIVITY_MAX_CHATS,
  AI_REPLY_ACTIVITY_MAX_TIMESTAMPS,
  AI_REPLY_ACTIVITY_WINDOW_MS,
  AI_REPLY_PROBABILITY_BASE_INITIAL,
  AI_REPLY_PROBABILITY_BASE_MIN,
} from "../../consts/aiChat/rateLimit";
import {
  aiReplyActivityByChat,
  aiReplyActivitySweepState,
  type AiReplyActivityEntry,
} from "../../cache/main/auto";
import { LinkedQueue } from "../../libs/linkedQueue";
import { trimSlidingWindow } from "../../libs/slidingWindowRateLimit";
import { setBoundedMapValue } from "../../libs/boundedMap";

function pruneEntry(entry: AiReplyActivityEntry, now: number): void {
  trimSlidingWindow({ timestamps: entry.timestamps, windowMs: AI_REPLY_ACTIVITY_WINDOW_MS, now });
}

/**
 * 清理已空闲满一小时的群。只有全局单 timer 调用这个 O(最多 500 群)
 * 扫描；每条消息的热路径只修剪它自己的队列。导出便于边界测试。
 */
export function sweepAiReplyActivity(now: number = Date.now()): void {
  for (const [chatId, entry] of aiReplyActivityByChat) {
    pruneEntry(entry, now);
    if (entry.timestamps.size === 0) aiReplyActivityByChat.delete(chatId);
  }
}

function scheduleNextSweep(now: number): void {
  if (aiReplyActivitySweepState.timer !== null || aiReplyActivityByChat.size === 0) return;
  let earliestExpiry: number = Number.POSITIVE_INFINITY;
  for (const entry of aiReplyActivityByChat.values()) {
    const oldest: number | undefined = entry.timestamps.peek();
    if (oldest !== undefined) earliestExpiry = Math.min(earliestExpiry, oldest + AI_REPLY_ACTIVITY_WINDOW_MS);
  }
  if (!Number.isFinite(earliestExpiry)) return;
  const delay: number = Math.max(1, earliestExpiry - now);
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    aiReplyActivitySweepState.timer = null;
    const currentTime: number = Date.now();
    sweepAiReplyActivity(currentTime);
    scheduleNextSweep(currentTime);
  }, delay);
  timer.unref();
  aiReplyActivitySweepState.timer = timer;
}

function probabilityFromCount(recentMessageCount: number): number {
  const base: number = Math.max(
    AI_REPLY_PROBABILITY_BASE_MIN,
    AI_REPLY_PROBABILITY_BASE_INITIAL - recentMessageCount
  );
  return 1 / base;
}

/**
 * 记录当前群消息并返回这一条应使用的 AI 随机搭话概率。当前消息
 * 先进滑动窗口，所以冷群第一条是 1/174；窗口内达到 165 条后封底
 * 1/10。队列 push/shift 和 Map 热度刷新都是 O(1)，到期修剪为均摊 O(1)。
 */
export function observeGroupMessageForAiReply(chatId: number, now: number = Date.now()): number {
  let entry: AiReplyActivityEntry | undefined = aiReplyActivityByChat.get(chatId);
  if (!entry) {
    // 容量淘汰交给下面那次 setBoundedMapValue：这条路径上 chatId 必定不在表里，
    // 共享实现的「新增键越界才淘汰最早项」与在这里先淘汰再插入完全等价。
    entry = { timestamps: new LinkedQueue<number>(), lastObservedAt: now };
  } else {
    // Date.now() 因系统校时短暂回退时仍保持队列单调，避免过期修剪失序。
    now = Math.max(now, entry.lastObservedAt);
    pruneEntry(entry, now);
    aiReplyActivityByChat.delete(chatId);
  }

  entry.timestamps.push(now);
  entry.lastObservedAt = now;
  while (entry.timestamps.size > AI_REPLY_ACTIVITY_MAX_TIMESTAMPS) entry.timestamps.shift();
  // 上面两条分支都保证此刻 chatId 不在表里（新群本来就没有，老群刚 delete 过），
  // 因此这一次写入既完成 LRU 热度刷新，也承担新增键的容量淘汰。
  setBoundedMapValue({
    map: aiReplyActivityByChat,
    key: chatId,
    value: entry,
    maxEntries: AI_REPLY_ACTIVITY_MAX_CHATS,
  });
  scheduleNextSweep(now);
  return probabilityFromCount(entry.timestamps.size);
}

/** 清理内存与唯一 timer；生产停机由进程回收，导出用于测试隔离。 */
export function clearAiReplyActivity(): void {
  if (aiReplyActivitySweepState.timer !== null) {
    clearTimeout(aiReplyActivitySweepState.timer);
    aiReplyActivitySweepState.timer = null;
  }
  aiReplyActivityByChat.clear();
}
