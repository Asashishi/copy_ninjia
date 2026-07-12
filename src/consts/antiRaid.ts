/** 反刷群私密模式（src/antiRaid.ts）的调参常量。 */

/** 计数窗口时长：15 秒内入群人数若超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 15 * 1000;
/** 15 秒窗口内触发私密模式的入群人数阈值。 */
export const JOIN_THRESHOLD: number = 150;
/** 私密模式（禁止普通成员拉人）持续时长。 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
