import { logger } from "../infra/logger";

/**
 * 带超时的 JSON API 请求：统一 AbortController 计时、非 2xx 与异常/超时的
 * 报错记录。请求失败、超时或非 2xx 响应时返回 null，具体响应体形状校验
 * 交给调用方。
 * @param errorLabel 出现在错误日志里的接口名（如「Open-Meteo API」），
 *   用于区分是哪次调用出的错。
 */
export async function fetchJsonWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  errorLabel: string
): Promise<unknown | null> {
  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response: Response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok) {
      logger.error(`${errorLabel} error: ${response.status} ${await response.text()}`);
      return null;
    }
    return await response.json();
  } catch (error: unknown) {
    logger.error(`Error calling ${errorLabel}:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
