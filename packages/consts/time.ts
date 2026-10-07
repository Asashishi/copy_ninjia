/** 东京天气工具的 IANA 时区名，与所查询的东京地理位置一致。所属模块：时间。 */
export const TOKYO_TIME_ZONE: string = "Asia/Tokyo";

/**
 * 固定 24 小时的毫秒数：公历日序与 UTC 日期算术的日长，以及以 24 小时计的时长常量的单位；
 * 不代表配置时区每个自然日的实际长度。所属模块：时间。
 */
export const DAY_MS: number = 24 * 60 * 60 * 1_000;

/**
 * 规范日期键 YYYY-MM-DD 的字面形态；公历有效性由 libs/time.ts 的 isCanonicalDateKey
 * 往返校验。所属模块：时间。
 */
export const DATE_KEY_PATTERN: Readonly<RegExp> = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 配置时区本地时间串 YYYY/MM/DD HH:mm:ss 的字面形态（libs/time.ts 的 formatLocalTime 产出）；
 * 身份记录的 blockedAt 与 AI 逐字记忆的 at 共用。所属模块：时间。
 */
export const LOCAL_TIMESTAMP_PATTERN: Readonly<RegExp> = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;

/** Bun/JSC Date 与 Temporal 接受的最大 epoch 毫秒；持久化时间列与按日判定共用。所属模块：时间。 */
export const MAX_EPOCH_MILLISECONDS: number = 8_640_000_000_000_000;

/** 启动校验使用的每日 cron 表达式，仅解析、不注册任务。所属模块：时区配置。 */
export const TIME_ZONE_VALIDATION_CRON: string = "0 0 * * *";

/**
 * 日期与时间串格式化接受的最小 epoch 毫秒：公元 1000-01-01T00:00Z 之后留一天时区余量，
 * 保证 getDateKey/formatLocalTime/formatLogTimestamp 的年份恒为四位。所属模块：时间。
 */
export const FORMAT_MIN_TIMESTAMP_MS: number = -30_610_224_000_000 + DAY_MS;

/**
 * 日期与时间串格式化接受的最大 epoch 毫秒：公元 9999-12-31T23:59:59.999Z 之前留一天时区余量，
 * 与 FORMAT_MIN_TIMESTAMP_MS 一起限定四位年份。所属模块：时间。
 */
export const FORMAT_MAX_TIMESTAMP_MS: number = 253_402_300_799_999 - DAY_MS;
