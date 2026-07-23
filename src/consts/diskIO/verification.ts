/** Anti-Raid 待验证增量 JSON 的合并与防御边界。 */

import { DAY_FILE_JSON_INDENT } from "./appendOnly";

/** 东京标准时相对 UTC 的固定毫秒偏移，用于计算下一次本地午夜。 */
export const TOKYO_OFFSET_MS: number = 9 * 60 * 60 * 1_000;
/** 公历日的固定毫秒数；只与固定 UTC+9 偏移配合，不用于有夏令时的时区。 */
export const DAY_MS: number = 24 * 60 * 60 * 1_000;
/** 匹配按约定缩进序列化的顶层 JSON 条目，用于统计追加历史。 */
export const VERIFICATION_TOP_LEVEL_ENTRY_PATTERN: RegExp = new RegExp(
  `^${" ".repeat(DAY_FILE_JSON_INDENT)}"(?:[^"\\\\]|\\\\.)+":`,
  "gm"
);

/** 普通消息 ID/提醒回填变化的短合并窗口；创建与终结立即追加。 */
export const VERIFICATION_FLUSH_INTERVAL_MS: number = 250;
/** 单次验证增量合并达到后立即刷盘的 key 数阈值。 */
export const VERIFICATION_FLUSH_MAX_KEYS: number = 100;
/** 重复历史达到任一阈值前收敛为 active 快照，避免当天文件无限增长。 */
export const VERIFICATION_FILE_COMPACT_ENTRIES: number = 10_000;
/** 待验证当日文件触发 active 快照收敛的字节阈值。 */
export const VERIFICATION_FILE_COMPACT_BYTES: number = 4 * 1024 * 1024;
/** 读取损坏/手工修改文件时的防御上限；运行时消息窗口会另设更小上限。 */
export const VERIFICATION_FILE_MAX_MESSAGE_IDS: number = 5_000;
