/** `/bot_status` 本机进程指标的换算与展示常量。 */

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
