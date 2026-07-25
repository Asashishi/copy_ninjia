/** 通用 JSON API 响应的内存与日志边界。 */

/**
 * 通用 JSON 请求入口允许访问的可信 origin；目前仅开放天气模块实际使用的
 * Open-Meteo HTTPS 服务。新增调用方必须在代码审查时显式扩充此列表。
 */
export const JSON_API_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  "https://api.open-meteo.com",
]);

/** 包含成功与错误响应体；流式读取同样强制执行，不能只信 Content-Length。 */
export const JSON_API_MAX_RESPONSE_BYTES: number = 1024 * 1024;

/** 非 2xx 正文只用于诊断，避免把接近响应上限的远端内容整段写进日志。 */
export const JSON_API_ERROR_LOG_MAX_CHARS: number = 1024;
