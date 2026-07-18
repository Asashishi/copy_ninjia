/** 反刷群私密模式的计数窗口、阈值与恢复策略。 */

/** 滑动计数窗口时长：最近这么长时间内的入群数超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 60 * 1000;
/**
 * 滑动窗口内触发私密模式的入群人数上限，超过（第 46 人起）才触发，见
 * workers/antiRaid/lockdownRuntime.ts 的 recordJoin 与待验证成员消息窗口。
 */
export const ANTI_RAID_PER_MINUTE_LIMIT: number = 45;
/** 私密模式（禁止普通成员拉人）持续时长。 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
