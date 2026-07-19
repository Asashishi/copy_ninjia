import { verificationKey } from "./keys";
import { recentChannelComments, type RecentChannelComment } from "../../cache/antiRaid/recentComments";
import { COMMENT_JOIN_CORRELATE_MS, RECENT_COMMENT_CACHE_MAX } from "../../consts/antiRaid/cache";

/**
 * 频道评论区留言的暂存：评论先到、入群更新后到时的关联缓冲，供
 * verificationRuntime.ts 的 handleJoin/handleTrackedMessage 消费。
 */

/**
 * 暂存一条「发言者当前没有验证状态记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；有效期内直接回复频道帖的标记一旦出现就保持（豁免的确证不被
 * 后续楼中楼回复降级）。不为每个成员创建 timer：统一由 Worker sweeper
 * 清理，读取路径自身也拒绝过期项。
 */
export function rememberRecentComment(chatId: number, userId: number, messageId: number, repliesToChannelPost: boolean, observedAt: number = Date.now()): void {
  const key: string = verificationKey(chatId, userId);
  const existing = recentChannelComments.get(key);
  const existingIsFresh: boolean = existing !== undefined && observedAt - existing.observedAt < COMMENT_JOIN_CORRELATE_MS;
  if (existing !== undefined) recentChannelComments.delete(key);

  if (recentChannelComments.size >= RECENT_COMMENT_CACHE_MAX) {
    sweepRecentComments(observedAt);
    if (recentChannelComments.size >= RECENT_COMMENT_CACHE_MAX) {
      // 每次更新都是「先 delete 旧 key 再 set」，Map 的插入序即观察时间序
      // （observedAt 随调用单调不减），最早项恒为迭代器第一项，O(1) 淘汰，
      // 不必线性扫描——raid 高峰持续触顶时这条路径每次插入都会走到。
      const earliestKey: string | undefined = recentChannelComments.keys().next().value;
      if (earliestKey !== undefined) recentChannelComments.delete(earliestKey);
    }
  }

  recentChannelComments.set(key, {
    messageId,
    repliesToChannelPost: repliesToChannelPost || (existingIsFresh && existing?.repliesToChannelPost === true),
    observedAt,
  });
}

/** 消费（取出并删除）某人最近暂存的评论区留言，没有则返回 undefined。 */
export function takeRecentComment(chatId: number, userId: number, now: number = Date.now()): RecentChannelComment | undefined {
  const key: string = verificationKey(chatId, userId);
  const entry = recentChannelComments.get(key);
  if (!entry) return undefined;
  recentChannelComments.delete(key);
  if (now - entry.observedAt >= COMMENT_JOIN_CORRELATE_MS) return undefined;
  return { messageId: entry.messageId, repliesToChannelPost: entry.repliesToChannelPost, observedAt: entry.observedAt };
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
