import { verificationKey } from "../../libs/verificationKey";
import { recentChannelComments } from "../../cache/antiRaid/recentComments";
import { COMMENT_JOIN_CORRELATE_MS, RECENT_COMMENT_CACHE_MAX } from "../../consts/antiRaid/cache";
import type { RecentChannelComment } from "../../types/antiRaid/internal";
import { setBoundedMapValue } from "../../libs/boundedMap";

/**
 * 频道评论区留言的暂存：评论先到、入群更新后到时的关联缓冲，供
 * verificationRuntime.ts 的 handleJoin/handleTrackedMessage 消费。
 */

/**
 * 暂存一条「发言者当前没有验证状态记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；直属评论和楼中楼回复在豁免语义上没有差别，因此缓存不再携带
 * 来源标记。不为每个成员创建 timer：统一由 Worker sweeper 清理，读取路径
 * 自身也拒绝过期项。
 */
export interface RememberRecentCommentParams {
  chatId: number;
  userId: number;
  messageId: number;
  observedAt?: number;
}

export function rememberRecentComment({
  chatId,
  userId,
  messageId,
  observedAt = Date.now(),
}: RememberRecentCommentParams): void {
  const key: string = verificationKey(chatId, userId);
  const existing: RecentChannelComment | undefined = recentChannelComments.get(key);
  if (existing !== undefined) recentChannelComments.delete(key);

  // 先按时间清一遍：能靠过期回收就不必淘汰还在窗口内的条目。
  if (recentChannelComments.size >= RECENT_COMMENT_CACHE_MAX) sweepRecentComments(observedAt);
  // 清完仍触顶时由共享实现淘汰最早插入项。每次更新都是「先 delete 旧 key 再
  // set」，Map 的插入序即观察时间序（observedAt 随调用单调不减），最早项恒为
  // 迭代器第一项，O(1) 淘汰，不必线性扫描——raid 高峰持续触顶时这条路径每次
  // 插入都会走到。
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

/** 由 Anti-Raid Worker 的唯一周期 sweeper 调用；返回删除数便于测试和观测。 */
export function sweepRecentComments(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const [key, entry] of recentChannelComments) {
    if (now - entry.observedAt >= COMMENT_JOIN_CORRELATE_MS) {
      recentChannelComments.delete(key);
      deleted++;
    }
  }
  return deleted;
}
