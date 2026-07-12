import { logger } from "./logger";
import { DEEPSEEK_API_KEY } from "./config";

/**
 * 查询 DeepSeek 账户余额，供 /balance 命令使用。
 */

const DEEPSEEK_BALANCE_API_URL: string = "https://api.deepseek.com/user/balance";
const REQUEST_TIMEOUT_MS: number = 10_000;

/** 余额缓存有效期：30 秒内的重复查询直接复用，避免多人连续 /balance 把接口打到 429。 */
const CACHE_TTL_MS: number = 30_000;

let cachedResult: DeepSeekBalanceResponse | null = null;
let cachedAt: number = 0;

export interface DeepSeekBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

/**
 * 请求失败、超时或返回数据格式不对时返回 null，由调用方决定如何降级。
 * 命中缓存（30 秒内）时直接返回缓存值，不发请求。
 */
export async function fetchDeepSeekBalance(): Promise<DeepSeekBalanceResponse | null> {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response: Response = await fetch(DEEPSEEK_BALANCE_API_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(`DeepSeek balance API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data: any = await response.json();
    if (!Array.isArray(data?.balance_infos)) {
      logger.error("DeepSeek balance API returned unexpected shape:", data);
      return null;
    }

    const result: DeepSeekBalanceResponse = {
      is_available: !!data.is_available,
      balance_infos: data.balance_infos,
    };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  } catch (error: unknown) {
    logger.error("Error calling DeepSeek balance API:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
