/** Anti-Raid 待验证增量 JSON 的合并与防御边界。 */

/** 普通消息 ID/提醒回填变化的短合并窗口；创建与终结立即追加。 */
export const VERIFICATION_FLUSH_INTERVAL_MS: number = 250;
export const VERIFICATION_FLUSH_MAX_KEYS: number = 100;
/** 重复历史达到任一阈值前收敛为 active 快照，避免当天文件无限增长。 */
export const VERIFICATION_FILE_COMPACT_ENTRIES: number = 10_000;
export const VERIFICATION_FILE_COMPACT_BYTES: number = 4 * 1024 * 1024;
/** 读取损坏/手工修改文件时的防御上限；运行时消息窗口会另设更小上限。 */
export const VERIFICATION_FILE_MAX_MESSAGE_IDS: number = 5_000;
