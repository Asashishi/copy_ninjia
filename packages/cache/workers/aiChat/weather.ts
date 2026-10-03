/** owner: workers/aiChat。天气缓存和刷新生命周期随 isolate 创建与销毁。 */
import type { TokyoWeatherResult } from "../../../types/aiChat/weather";

/**
 * 东京天气服务（packages/aiChat/ai/weather.ts）的内存缓存：仅存最近一次成功结果
 * （失败不缓存，下次照常重试）。容量固定为一个 holder，Worker 崩溃时随 isolate 销毁，
 * 重建后由下一次刷新重新填充。只有 aiChat/ai/weather.ts 写入；get_tokyo_weather 工具
 * （aiChat/ai/tools/index.ts）与心情系统（aiChat/ai/mood.ts）直接只读 current，null 表示
 * 首次成功刷新尚未完成；刷新节奏见 consts/weather.ts 的 WEATHER_REFRESH_INTERVAL_MS。
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

/**
 * 唯一天气刷新循环的取消句柄，启动时填充，停止时先清空再取消在途请求。
 * 容量固定为一个 holder；Worker 崩溃时随 isolate 销毁，重建后由启动入口重新创建。
 */
export const weatherRefreshController: { current: AbortController | null } = { current: null };
