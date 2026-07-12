import { logger } from "../infra/logger";
import { DEEPSEEK_API_KEY } from "../infra/config";
import { CACHE_TTL_MS, DEEPSEEK_BALANCE_API_URL, REQUEST_TIMEOUT_MS } from "../consts/deepseekBalance";
import { balanceCache } from "../cache/deepseekBalance";
import type { DeepSeekBalanceResponse } from "../types";

/**
 * 查询 DeepSeek 账户余额，供 /balance 命令使用。
 */

/**
 * 请求失败、超时或返回数据格式不对时返回 null，由调用方决定如何降级。
 * 命中缓存（30 秒内）时直接返回缓存值，不发请求。
 */
export async function fetchDeepSeekBalance(): Promise<DeepSeekBalanceResponse | null> {
  if (balanceCache.result && Date.now() - balanceCache.at < CACHE_TTL_MS) {
    return balanceCache.result;
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
    balanceCache.result = result;
    balanceCache.at = Date.now();
    return result;
  } catch (error: unknown) {
    logger.error("Error calling DeepSeek balance API:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
