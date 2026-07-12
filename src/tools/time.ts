/**
 * AI 工具:获取当前时间。统一用东京时区（UTC+9），与天气工具及群里日常
 * 报时口径保持一致。
 */

export interface CurrentTimeResult {
  iso: string;
  timezone: string;
  formatted: string;
}

export function getCurrentTime(): CurrentTimeResult {
  const now: Date = new Date();
  const formatted: string = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(now);

  return {
    iso: now.toISOString(),
    timezone: "Asia/Tokyo",
    formatted,
  };
}
