/**
 * 每个线程独立构造的默认时区、当前时间格式器，以及一段可替换的 UTC 偏移区段缓存。
 * 时区与格式器构造后不变；区段各字段只由 libs/time.ts 在未命中时整体改写。
 */
export interface TimeZoneState {
  readonly timeZone: string;
  readonly fullTimeFormatter: Readonly<Intl.DateTimeFormat>;
  /** 当前缓存的 UTC 偏移区段 [offsetStartMs, offsetEndMs)；初值为空区段（start > end）。 */
  offsetStartMs: number;
  offsetEndMs: number;
  /** 区段内恒定的 UTC 偏移毫秒数。 */
  offsetMs: number;
}

/** 供模型请求使用的同一时刻的 UTC 时间、配置时区名与本地化描述。 */
export interface CurrentTimeResult {
  readonly iso: string;
  readonly timezone: string;
  readonly formatted: string;
}
