import { verificationKey } from "./keys";
import { recentChannelComments } from "../../cache/antiRaidWorker";
import { COMMENT_JOIN_CORRELATE_MS } from "../../consts/antiRaid";

/**
 * 频道评论区留言的暂存：评论先到、入群更新后到时的关联缓冲，供
 * verificationRuntime.ts 的 handleJoin/handleTrackedMessage 消费。
 */

/**
 * 暂存一条「发言者当前没有验证状态记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；直接回复频道帖的标记一旦出现就保持（豁免的确证不被后续楼中楼
 * 回复降级）。
 */
export function rememberRecentComment(chatId: number, userId: number, messageId: number, repliesToChannelPost: boolean, observedAt: number = Date.now()): void {
  const key: string = verificationKey(chatId, userId);
  const existing = recentChannelComments.get(key);
  if (existing) clearTimeout(existing.cleanup);
  recentChannelComments.set(key, {
    messageId,
    repliesToChannelPost: repliesToChannelPost || existing?.repliesToChannelPost === true,
    observedAt,
    cleanup: setTimeout(() => recentChannelComments.delete(key), COMMENT_JOIN_CORRELATE_MS),
  });
}

/** 消费（取出并删除）某人最近暂存的评论区留言，没有则返回 undefined。 */
export function takeRecentComment(chatId: number, userId: number): { messageId: number; repliesToChannelPost: boolean; observedAt: number } | undefined {
  const key: string = verificationKey(chatId, userId);
  const entry = recentChannelComments.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.cleanup);
  recentChannelComments.delete(key);
  return { messageId: entry.messageId, repliesToChannelPost: entry.repliesToChannelPost, observedAt: entry.observedAt };
}
