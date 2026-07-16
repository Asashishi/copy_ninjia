import type { CurrentTimeResult } from "../types";

/**
 * 获取当前时间。统一用东京时区（UTC+9），与天气工具及群里日常报时口径
 * 保持一致。不是 function calling 工具——当前时间默认拼进每次 xAI 请求的
 * 系统提示词（见 workers/aiChatWorker.ts 的 callGrok/summarizeBatch），
 * 模型不需要自己判断要不要查。
 */

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
