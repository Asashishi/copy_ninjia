/** 通用 JSON API 响应的内存与日志边界。 */

/** 包含成功与错误响应体；流式读取同样强制执行，不能只信 Content-Length。 */
export const JSON_API_MAX_RESPONSE_BYTES: number = 1024 * 1024;

/** 非 2xx 正文只用于诊断，避免把接近响应上限的远端内容整段写进日志。 */
export const JSON_API_ERROR_LOG_MAX_CHARS: number = 1024;
