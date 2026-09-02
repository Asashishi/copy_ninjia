import type { TokyoWeatherResult } from "../../../types/aiChat/weather";

/**
 * 东京天气服务（packages/aiChat/ai/weather.ts）的内存缓存：仅存最近一次成功结果
 * （失败不缓存，下次照常重试）。容量固定为一个 holder，Worker 崩溃时随 isolate 销毁，
 * 重建后由下一次刷新重新填充。get_tokyo_weather 工具与心情系统（aiChat/ai/mood.ts）
 * 都经 aiChat/ai/weather.ts 的 currentTokyoWeather 读取，不直接 import 这个对象；
 * 刷新节奏见 consts/weather.ts 的 WEATHER_REFRESH_INTERVAL_MS。
 */
export const weatherCache: { current: TokyoWeatherResult | null } = {
  current: null,
};

/**
 * AI Worker 内唯一的天气刷新 interval。startWeatherRefreshLoop 填充，
 * stopWeatherRefreshLoop 清除；Worker 强制崩溃时随 isolate 销毁，重建后
 * 重新启动，容量固定为一个 timer。
 */
export const weatherRefreshTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
