import { logger } from "../infra/logger";
import { DEEPSEEK_API_KEY } from "../infra/config";
import { CACHE_TTL_MS, DEEPSEEK_BALANCE_API_URL, REQUEST_TIMEOUT_MS } from "../consts/deepseekBalance";
import { balanceCache } from "../cache/deepseekBalance";
import { fetchJsonWithTimeout } from "../libs/httpFetch";
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

  const data: any = await fetchJsonWithTimeout(
    DEEPSEEK_BALANCE_API_URL,
    { method: "GET", headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` } },
    REQUEST_TIMEOUT_MS,
    "DeepSeek balance API"
  );
  if (data === null) return null;

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
}
