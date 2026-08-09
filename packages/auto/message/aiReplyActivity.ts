import {
  AI_REPLY_ACTIVITY_MAX_CHATS,
  AI_REPLY_ACTIVITY_MAX_TIMESTAMPS,
  AI_REPLY_ACTIVITY_WINDOW_MS,
  AI_REPLY_PROBABILITY_BASE_INITIAL,
  AI_REPLY_PROBABILITY_BASE_MIN,
} from "../../consts/aiChat/rateLimit";
import {
  aiReplyActivityByChat,
  aiReplyActivitySequenceState,
  aiReplyActivitySweepState,
} from "../../cache/main/auto";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { AiReplyActivityEntry } from "../../types/auto";

function pruneEntry(entry: AiReplyActivityEntry, now: number): void {
  entry.timestamps.trim(AI_REPLY_ACTIVITY_WINDOW_MS, now);
}

/**
 * 满载插入新群时扫描固定上限的表并淘汰 LRU。把 O(最多 500 群) 的工作留在
 * 缓存 miss 冷路径，避免每条已有群消息通过 Map delete/set 制造短命桶对象。
 */
function evictLeastRecentlyUsedActivityEntry(): void {
  let oldestChatId: number | undefined;
  let oldestSequence: number = Number.POSITIVE_INFINITY;
  for (const [candidateChatId, candidateEntry] of aiReplyActivityByChat) {
    if (candidateEntry.lastAccessSequence >= oldestSequence) continue;
    oldestChatId = candidateChatId;
    oldestSequence = candidateEntry.lastAccessSequence;
  }
  if (oldestChatId !== undefined) aiReplyActivityByChat.delete(oldestChatId);
}

/** chatId 已不在表中时写回，并在硬上限处按严格访问次序淘汰 LRU。 */
function storeActivityEntry(
  chatId: number,
  entry: AiReplyActivityEntry
): void {
  if (aiReplyActivityByChat.size >= AI_REPLY_ACTIVITY_MAX_CHATS) {
    evictLeastRecentlyUsedActivityEntry();
  }
  aiReplyActivityByChat.set(chatId, entry);
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
 * 记录当前群消息并返回这一条应使用的 AI 随机搭话概率。当前消息先进滑动
 * 窗口；同群近期消息越多，概率越高，但不会越过热群下限。队列 push/shift
 * 和 Map 热度刷新都是 O(1)，到期修剪为均摊 O(1)。
 */
export function observeGroupMessageForAiReply(chatId: number, now: number = Date.now()): number {
  let entry: AiReplyActivityEntry | undefined = aiReplyActivityByChat.get(chatId);
  const isNewEntry: boolean = entry === undefined;
  if (!entry) {
    entry = {
      timestamps: new TimestampDeque(AI_REPLY_ACTIVITY_MAX_TIMESTAMPS),
      lastAccessSequence: 0,
      lastObservedAt: now,
    };
  } else {
    // Date.now() 因系统校时短暂回退时仍保持队列单调，避免过期修剪失序。
    now = Math.max(now, entry.lastObservedAt);
    pruneEntry(entry, now);
  }

  if (entry.timestamps.size === AI_REPLY_ACTIVITY_MAX_TIMESTAMPS) {
    entry.timestamps.shift();
  }
  entry.timestamps.push(now);
  entry.lastObservedAt = now;
  aiReplyActivitySequenceState.current += 1;
  entry.lastAccessSequence = aiReplyActivitySequenceState.current;
  if (isNewEntry) storeActivityEntry(chatId, entry);
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
  aiReplyActivitySequenceState.current = 0;
}
