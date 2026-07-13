import type { TimedCache, TokyoWeatherResult } from "../types";

/**
 * 东京天气工具（src/tools/weather.ts）的内存缓存：仅存最近一次成功结果及其
 * 时刻（失败不缓存，下次照常重试），有效期见 consts/weather.ts 的 CACHE_TTL_MS。
 */
export const weatherCache: TimedCache<TokyoWeatherResult> = {
  result: null,
  at: 0,
};
