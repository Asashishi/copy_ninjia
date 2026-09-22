import { verificationKey } from "../../libs/verificationKey";
import {
  recentChannelComments,
  recentCommentsMinObservedAt,
} from "../../cache/workers/antiRaid/recentComments";
import { COMMENT_JOIN_CORRELATE_MS, RECENT_COMMENT_CACHE_MAX } from "../../consts/antiRaid/cache";
import type { RecentChannelComment } from "../../types/antiRaid/internal";
import { setBoundedMapValue } from "../../libs/boundedMap";

/**
 * 频道评论区留言的暂存：评论先到、入群更新后到时的关联缓冲，供
 * verificationRuntime.ts 的 handleJoin/handleTrackedMessage 消费。
 */

export interface RememberRecentCommentParams {
  chatId: number;
  userId: number;
  messageId: number;
  observedAt: number;
}

/**
 * 暂存一条「发言者当前没有验证状态记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；直属评论和楼中楼回复在豁免语义上没有差别，因此缓存不携带来源
 * 标记。不为每个成员创建 timer：统一由 Worker sweeper 清理，读取路径自身
 * 也拒绝过期项。
 */
export function rememberRecentComment({
  chatId,
  userId,
  messageId,
  observedAt,
}: RememberRecentCommentParams): void {
  const key: string = verificationKey(chatId, userId);
  const existing: RecentChannelComment | undefined = recentChannelComments.get(key);
  if (existing !== undefined) recentChannelComments.delete(key);

  // 先按时间清一遍：能靠过期回收就不必淘汰还在窗口内的条目。最小 observedAt 的
  // 下界证明没有到期条目时跳过这次整表扫描（raid 高峰持续触顶时每次插入都会走到）。
  if (
    recentChannelComments.size >= RECENT_COMMENT_CACHE_MAX &&
    observedAt - recentCommentsMinObservedAt.current >= COMMENT_JOIN_CORRELATE_MS
  ) {
    sweepRecentComments(observedAt);
  }
  if (observedAt < recentCommentsMinObservedAt.current) recentCommentsMinObservedAt.current = observedAt;
  // 清完仍触顶时由共享实现淘汰最早插入项。每次更新都是「先 delete 旧 key 再
  // set」，Map 的插入序即观察时间序（observedAt 随调用单调不减），最早项恒为
  // 迭代器第一项，O(1) 淘汰，不必线性扫描。
  setBoundedMapValue({
    map: recentChannelComments,
    key,
    value: { messageId, observedAt },
    maxEntries: RECENT_COMMENT_CACHE_MAX,
  });
}

/** 消费（取出并删除）某人最近暂存的评论区留言，没有则返回 undefined。 */
export function takeRecentComment(chatId: number, userId: number, now: number = Date.now()): RecentChannelComment | undefined {
  const key: string = verificationKey(chatId, userId);
  const entry: RecentChannelComment | undefined = recentChannelComments.get(key);
  if (!entry) return undefined;
  recentChannelComments.delete(key);
  if (now - entry.observedAt >= COMMENT_JOIN_CORRELATE_MS) return undefined;
  return { messageId: entry.messageId, observedAt: entry.observedAt };
}

/**
 * 由 Anti-Raid Worker 的唯一周期 sweeper 调用；删除到期项并把 observedAt 下界重算为
 * 剩余条目的精确最小值。返回删除数便于测试和观测。
 */
export function sweepRecentComments(now: number = Date.now()): number {
  let deleted: number = 0;
  let minObservedAt: number = Number.POSITIVE_INFINITY;
  for (const [key, entry] of recentChannelComments) {
    if (now - entry.observedAt >= COMMENT_JOIN_CORRELATE_MS) {
      recentChannelComments.delete(key);
      deleted++;
    } else if (entry.observedAt < minObservedAt) {
      minObservedAt = entry.observedAt;
    }
  }
  recentCommentsMinObservedAt.current = minObservedAt;
  return deleted;
}

/** Worker 停止时清空暂存表并复位 observedAt 下界。 */
export function resetRecentComments(): void {
  recentChannelComments.clear();
  recentCommentsMinObservedAt.current = Number.POSITIVE_INFINITY;
}
