/** DeepSeek 余额查询（src/deepseekBalance.ts）的调参常量。 */

export const DEEPSEEK_BALANCE_API_URL: string = "https://api.deepseek.com/user/balance";
export const REQUEST_TIMEOUT_MS: number = 10_000;

/** 余额缓存有效期：30 秒内的重复查询直接复用，避免多人连续 /balance 把接口打到 429。 */
export const CACHE_TTL_MS: number = 30_000;
