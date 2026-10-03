/** 东京天气工具的 IANA 时区名，与所查询的东京地理位置一致。所属模块：时间。 */
export const TOKYO_TIME_ZONE: string = "Asia/Tokyo";

/** Bun/JSC Date 与 Temporal 接受的最大 epoch 毫秒；持久化时间列与按日判定共用。所属模块：时间。 */
export const MAX_EPOCH_MILLISECONDS: number = 8_640_000_000_000_000;

/** 启动校验使用的每日 cron 表达式，仅解析、不注册任务。所属模块：时区配置。 */
export const TIME_ZONE_VALIDATION_CRON: string = "0 0 * * *";

/**
 * 日期与时间串格式化接受的最小 epoch 毫秒：公元 1000-01-01T00:00Z 之后留一天时区余量，
 * 保证 getDateKey/formatLocalTime/formatLogTimestamp 的年份恒为四位。所属模块：时间。
 */
export const FORMAT_MIN_TIMESTAMP_MS: number = -30_610_224_000_000 + 86_400_000;

/**
 * 日期与时间串格式化接受的最大 epoch 毫秒：公元 9999-12-31T23:59:59.999Z 之前留一天时区余量，
 * 与 FORMAT_MIN_TIMESTAMP_MS 一起限定四位年份。所属模块：时间。
 */
export const FORMAT_MAX_TIMESTAMP_MS: number = 253_402_300_799_999 - 86_400_000;
