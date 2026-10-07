import { logger } from "./logger";
import {
  JSON_API_ALLOWED_ORIGINS,
  JSON_API_ERROR_LOG_MAX_CHARS,
  JSON_API_MAX_RESPONSE_BYTES,
} from "../consts/httpFetch";
import { signalWithTimeout } from "../libs/abortSignal";
import { readBoundedResponseBytes } from "../libs/boundedResponse";
import { parseAllowedHttpsUrl } from "../libs/httpUrlPolicy";
import type { BoundedResponseResult } from "../libs/boundedResponse";

/** 所有 JSON 响应共用一个非 fatal UTF-8 解码器。 */
const UTF8_DECODER: TextDecoder = new TextDecoder();

function boundedErrorPreview(text: string): string {
  if (text.length <= JSON_API_ERROR_LOG_MAX_CHARS) return text;
  return `${text.slice(0, JSON_API_ERROR_LOG_MAX_CHARS)}…`;
}

/** fetchJsonWithTimeout 的入参。 */
export interface FetchJsonWithTimeoutParams {
  input: string | URL;
  init: RequestInit;
  timeoutMs: number;
  /** 出现在错误日志里的接口名（如「Open-Meteo API」）。 */
  errorLabel: string;
}

/**
 * 带超时和响应体上限（JSON_API_MAX_RESPONSE_BYTES）的 JSON API 请求。成功与失败正文
 * 都经过同一个流式 bounded reader，不依赖 Content-Length。请求失败、调用方取消、
 * 超时、超限、非法 JSON 或非 2xx 时返回 null，具体 JSON 形状校验交给调用方；
 * 调用方取消不记错误日志。请求地址必须命中 JSON_API_ALLOWED_ORIGINS，且不跟随
 * 重定向。Telegram 头像爬取使用独立的 HTML/图片下载链路，不受此 JSON API 列表约束。
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
  const callerSignal: AbortSignal | undefined = init.signal ?? undefined;
  const signal: AbortSignal = signalWithTimeout(callerSignal, timeoutMs);
  try {
    signal.throwIfAborted();
    const response: Response = await fetch(requestUrl, {
      ...init,
      redirect: "error",
      signal,
    });
    const body: BoundedResponseResult = await readBoundedResponseBytes(response, JSON_API_MAX_RESPONSE_BYTES);
    signal.throwIfAborted();
    if (!body.ok) {
      logger.error(`${errorLabel} response exceeded ${JSON_API_MAX_RESPONSE_BYTES} bytes (observed ${body.observedBytes}).`);
      return null;
    }
    const text: string = UTF8_DECODER.decode(body.bytes);
    if (!response.ok) {
      logger.error(`${errorLabel} error: ${response.status} ${boundedErrorPreview(text)}`);
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (callerSignal?.aborted !== true) logger.error(`Error calling ${errorLabel}:`, error);
    return null;
  }
}
