import { logger } from "./logger";
import {
  JSON_API_ALLOWED_ORIGINS,
  JSON_API_ERROR_LOG_MAX_CHARS,
  JSON_API_MAX_RESPONSE_BYTES,
} from "../consts/httpFetch";
import { readBoundedResponseBytes } from "../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../libs/httpUrlPolicy";
import type { BoundedResponseResult } from "../libs/boundedResponse";

function boundedErrorPreview(text: string): string {
  if (text.length <= JSON_API_ERROR_LOG_MAX_CHARS) return text;
  return `${text.slice(0, JSON_API_ERROR_LOG_MAX_CHARS)}…`;
}

/** fetchJsonWithTimeout 的入参。 */
export interface FetchJsonWithTimeoutParams {
  input: string | URL;
  init: RequestInit;
  timeoutMs: number;
  /**
   * 出现在错误日志里的接口名（如「Open-Meteo API」），用于区分是哪次调用
   * 出的错。
   */
  errorLabel: string;
}

/**
 * 带超时和响应体硬上限的 JSON API 请求。成功/失败正文都经过同一个流式
 * bounded reader，不能因缺失或伪造 Content-Length 而无界占用内存。请求
 * 失败、超时、超限、非法 JSON 或非 2xx 时返回 null，具体 JSON 形状校验
 * 交给调用方。请求地址必须命中 JSON_API_ALLOWED_ORIGINS，且禁止自动跟随
 * 重定向，避免可信服务把通用请求能力转交给未经允许的目标。Telegram 头像
 * 爬取使用独立的 HTML/图片下载链路，不受此 JSON API 列表约束。
 */
export async function fetchJsonWithTimeout({
  input,
  init,
  timeoutMs,
  errorLabel,
}: FetchJsonWithTimeoutParams): Promise<unknown> {
  const requestUrl: URL | null = parseAllowedHttpsUrl({
    input,
    policy: { allowedOrigins: JSON_API_ALLOWED_ORIGINS },
  });
  if (requestUrl === null) {
    logger.error(`${errorLabel} request URL is not in the configured allowlist.`);
    return null;
  }
  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => controller.abort(), timeoutMs);
  try {
    const response: Response = await fetch(requestUrl, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const body: BoundedResponseResult = await readBoundedResponseBytes(response, JSON_API_MAX_RESPONSE_BYTES);
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
