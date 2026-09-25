/** `/bot_status` 本机进程指标的换算与展示常量。 */

import type { ChatStateSwitchKey } from "../types/chatState";

/** 一秒包含的微秒数；用于把 process.cpuUsage 与 uptime 放到同一量纲。 */
export const BOT_STATUS_MICROSECONDS_PER_SECOND: number = 1_000_000;

/** 百分比换算倍率；CPU 与内存占比统一使用。 */
export const BOT_STATUS_PERCENT_SCALE: number = 100;

/** `/bot_status` 百分比和容量统一保留的小数位数。 */
export const BOT_STATUS_DECIMAL_PLACES: number = 2;

/** 一分钟包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_MINUTE: number = 60;

/** 一小时包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_HOUR: number = 60 * BOT_STATUS_SECONDS_PER_MINUTE;

/** 一天包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_DAY: number = 24 * BOT_STATUS_SECONDS_PER_HOUR;

/** 一个 KiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_KIB: number = 1_024;

/** 一个 MiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_MIB: number =
  BOT_STATUS_BYTES_PER_KIB * BOT_STATUS_BYTES_PER_KIB;

/** 一个 GiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_GIB: number =
  BOT_STATUS_BYTES_PER_MIB * BOT_STATUS_BYTES_PER_KIB;

/**
 * 本群上下文容量里滑动热记忆占的比重。
 *
 * `/bot_status` 的上下文容量是两段记忆各自占用率的加权和：滑动热记忆按
 * VERBATIM_CONTEXT_MAX 算占用率，冷记忆摘要按 MAX_SUMMARY_ROUNDS 算（两个上限
 * 都在 consts/aiChat/memory.ts）。**本值与 BOT_STATUS_COLD_MEMORY_WEIGHT 之和
 * 恒为 1**，否则两段都满时给不出 100%。所属模块：packages/commands/botStatus.ts。
 */
export const BOT_STATUS_HOT_MEMORY_WEIGHT: number = 0.7;

/**
 * 本群上下文容量里冷记忆摘要占的比重；与 BOT_STATUS_HOT_MEMORY_WEIGHT 之和恒为 1。
 * 所属模块：packages/commands/botStatus.ts。
 */
export const BOT_STATUS_COLD_MEMORY_WEIGHT: number = 0.3;

/** 权限块与功能块的 JSON 缩进空格数；两格让 Telegram 代码块里逐行可读。 */
export const BOT_STATUS_JSON_INDENT: number = 2;
/** 权限块与功能块 `pre` 实体的语言标签，让客户端按 JSON 高亮。 */
export const BOT_STATUS_JSON_LANGUAGE: string = "json";

/**
 * `/bot_status` 功能块列出的群开关字段名与展示顺序，属 packages/commands/botStatus.ts。
 * 键就是 state 里的开关名，值是该开关此刻的真假；新增群开关时在这里补一项，漏了那一项
 * 就不会出现在功能块里。
 */
export const BOT_STATUS_FEATURE_KEYS: readonly ChatStateSwitchKey[] = [
  "isInitEnabled",
  "isAIChatEnabled",
  "isTranslationEnabled",
  "isAdDetectEnabled",
  "isFloodControlEnabled",
  "isAntiRaidEnabled",
  "isProxySendEnabled",
];
