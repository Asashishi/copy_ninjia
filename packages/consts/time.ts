/** 东京相对 UTC 的固定毫秒偏移；用于自然日序号与东京零点时间戳互换。所属模块：时间。 */
export const TOKYO_UTC_OFFSET_MS: number = 9 * 60 * 60 * 1_000;

/**
 * 东京的 IANA 时区名；当前时间的格式化与对外字段（libs/time.ts 的 getCurrentTime）以及
 * 天气请求的时区参数（aiChat/ai/weather.ts）共用。所属模块：时间。
 */
export const TOKYO_TIME_ZONE: string = "Asia/Tokyo";
