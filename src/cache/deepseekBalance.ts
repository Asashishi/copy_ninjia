import type { DeepSeekBalanceResponse, TimedCache } from "../types";

/**
 * DeepSeek 余额查询（src/ai/deepseekBalance.ts）的内存缓存：仅存最近一次成功
 * 结果及其时刻（失败不缓存），有效期见 consts/deepseekBalance.ts 的 CACHE_TTL_MS。
 */
export const balanceCache: TimedCache<DeepSeekBalanceResponse> = {
  result: null,
  at: 0,
};
