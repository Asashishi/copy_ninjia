import type { RecentChannelComment } from "../../../types/antiRaid/internal";

/** 频道评论区留言暂存缓冲（packages/workers/antiRaid/recentComments.ts）的内存状态。 */

/**
 * 评论先于入群事件到达时的短期关联缓冲，以 "chatId:userId" 为键。
 * rememberRecentComment 在留言到达且发言者尚无验证记录时写入（同人连发
 * 只留最新，旧条目先删再插，Map 插入序即观察时间序）；takeRecentComment
 * 命中入群事件时取出即删。容量硬顶 RECENT_COMMENT_CACHE_MAX：写入时若已满且
 * recentCommentsMinObservedAt 显示可能有到期条目，先内联触发一次 sweep，仍满则按
 * 插入序淘汰最早一条。超过
 * COMMENT_JOIN_CORRELATE_MS 未被消费的条目由 Anti-Raid Worker 的周期
 * sweeper（sweepRecentComments）统一清理，读取路径自身也会拒绝已过期项。
 * 不落盘；Worker 重启后清空，尚未匹配上的留言直接丢失。
 */
export const recentChannelComments: Map<string, RecentChannelComment> = new Map();

/**
 * recentChannelComments 里最小 observedAt 的下界（ms）；自上次 sweep 起表空时为 +Infinity。
 * rememberRecentComment 写入时下移，sweepRecentComments 整表扫描后重算为精确最小值；
 * 取出、同键覆盖与容量淘汰只删条目，下界仍然成立。满表写入时
 * `observedAt - current < COMMENT_JOIN_CORRELATE_MS` 即证明表内没有到期条目，内联 sweep
 * 跳过。Worker 停止时随表一起复位（resetRecentComments）；Worker 重建后为初始值。
 */
export const recentCommentsMinObservedAt: { current: number } = { current: Number.POSITIVE_INFINITY };
