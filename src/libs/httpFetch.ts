import { logger } from "../infra/logger";
import { JSON_API_ERROR_LOG_MAX_CHARS, JSON_API_MAX_RESPONSE_BYTES } from "../consts/httpFetch";
import { readBoundedResponseBytes } from "./boundedResponse";

function boundedErrorPreview(text: string): string {
  if (text.length <= JSON_API_ERROR_LOG_MAX_CHARS) return text;
  return `${text.slice(0, JSON_API_ERROR_LOG_MAX_CHARS)}…`;
}

/**
 * 带超时和响应体硬上限的 JSON API 请求。成功/失败正文都经过同一个流式
 * bounded reader，不能因缺失或伪造 Content-Length 而无界占用内存。请求
 * 失败、超时、超限、非法 JSON 或非 2xx 时返回 null，具体 JSON 形状校验
 * 交给调用方。
 * @param errorLabel 出现在错误日志里的接口名（如「Open-Meteo API」），
 *   用于区分是哪次调用出的错。
 */
export async function fetchJsonWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  errorLabel: string
): Promise<unknown> {
  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response: Response = await fetch(input, { ...init, signal: controller.signal });
    const body = await readBoundedResponseBytes(response, JSON_API_MAX_RESPONSE_BYTES);
    if (!body.ok) {
      logger.error(`${errorLabel} response exceeded ${JSON_API_MAX_RESPONSE_BYTES} bytes (observed ${body.observedBytes}).`);
      return null;
    }
    const text: string = new TextDecoder().decode(body.bytes);
    if (!response.ok) {
      logger.error(`${errorLabel} error: ${response.status} ${boundedErrorPreview(text)}`);
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    logger.error(`Error calling ${errorLabel}:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
