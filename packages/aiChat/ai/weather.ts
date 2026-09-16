import { logger } from "../../infra/logger";
import {
  TOKYO_LATITUDE,
  TOKYO_LONGITUDE,
  WEATHER_API_URL,
  WEATHER_CODE_DESCRIPTIONS,
  WEATHER_REFRESH_INTERVAL_MS,
  WEATHER_REQUEST_TIMEOUT_MS,
} from "../../consts/weather";
import {
  weatherCache,
  weatherRefreshController,
  weatherRefreshTimer,
} from "../../cache/workers/aiChat/weather";
import { fetchJsonWithTimeout } from "../../infra/httpFetch";
import { isPlainRecord } from "../../libs/record";
import type { TokyoWeatherResult } from "../../types/aiChat/weather";

/**
 * 东京天气：唯一的数据来源与刷新入口。get_tokyo_weather 工具（见
 * aiChat/ai/tools/index.ts）与心情系统（见 aiChat/ai/mood.ts）共用同一份缓存，两边都
 * 只经 currentTokyoWeather 读缓存、不各自发请求——真正的网络请求只发生在
 * 本模块内部的定时刷新循环里（startWeatherRefreshLoop，由
 * workers/aiChatWorker.ts 在 Worker 启动时调用一次），用 Open-Meteo 的免费
 * 公开端点（不需要 API key，也没有调用额度限制）。
 */

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `未知天气现象（代码 ${code}）`;
}

/**
 * 请求 Open-Meteo，仅当前刷新循环可写缓存。失败、超时或非法响应保留上次结果。
 */
async function refreshTokyoWeather(controller: AbortController): Promise<void> {
  if (weatherRefreshController.current !== controller) return;
  const url: URL = new URL(WEATHER_API_URL);
  url.searchParams.set("latitude", String(TOKYO_LATITUDE));
  url.searchParams.set("longitude", String(TOKYO_LONGITUDE));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", "Asia/Tokyo");

  const data: unknown = await fetchJsonWithTimeout({
    input: url,
    init: { signal: controller.signal },
    timeoutMs: WEATHER_REQUEST_TIMEOUT_MS,
    errorLabel: "Open-Meteo API",
  });
  if (data === null || weatherRefreshController.current !== controller) return;

  const record: Record<string, unknown> = isPlainRecord(data) ? data : {};
  const current: Record<string, unknown> = isPlainRecord(record.current)
    ? record.current
    : {};
  const daily: Record<string, unknown> = isPlainRecord(record.daily)
    ? record.daily
    : {};
  const first = (value: unknown): unknown => Array.isArray(value) ? value[0] : undefined;
  const currentTemperatureC: unknown = current.temperature_2m;
  const currentCode: unknown = current.weather_code;
  const todayMaxC: unknown = first(daily.temperature_2m_max);
  const todayMinC: unknown = first(daily.temperature_2m_min);
  const todayCode: unknown = first(daily.weather_code);

  if (
    typeof currentTemperatureC !== "number" ||
    typeof currentCode !== "number" ||
    typeof todayMaxC !== "number" ||
    typeof todayMinC !== "number" ||
    typeof todayCode !== "number"
  ) {
    logger.error("Open-Meteo API returned unexpected shape:", data);
    return;
  }

  weatherCache.current = {
    currentTemperatureC,
    currentCondition: describeWeatherCode(currentCode),
    todayMaxC,
    todayMinC,
    todayCondition: describeWeatherCode(todayCode),
  };
}

/**
 * 读取当前缓存的东京天气；首次成功刷新之前返回 null。get_tokyo_weather 工具与心情系统都只应该走这个
 * 函数，不直接碰 weatherCache——本模块是缓存的唯一写入者，调用方不需要、
 * 也不应该知道背后是个可变的缓存对象。
 */
export function currentTokyoWeather(): TokyoWeatherResult | null {
  return weatherCache.current;
}

/**
 * 启动每小时一次的天气后台刷新：立即刷新一次（让缓存尽快就绪，不必等
 * 满一个整点周期），此后按 WEATHER_REFRESH_INTERVAL_MS 定期刷新。
 * Worker 启动时调用；循环存在时重复调用无副作用。刷新失败保留缓存并按周期重试。
 */
export function startWeatherRefreshLoop(): void {
  if (weatherRefreshTimer.current !== null) return;
  const controller: AbortController = new AbortController();
  weatherRefreshController.current = controller;
  void refreshTokyoWeather(controller);
  weatherRefreshTimer.current = setInterval((): undefined => void refreshTokyoWeather(controller), WEATHER_REFRESH_INTERVAL_MS);
  weatherRefreshTimer.current.unref();
}

/** 停止刷新并取消在途请求，迟到结果不得写回；Worker 重建后由启动入口重新创建。 */
export function stopWeatherRefreshLoop(): void {
  if (weatherRefreshTimer.current !== null) clearInterval(weatherRefreshTimer.current);
  weatherRefreshTimer.current = null;
  const controller: AbortController | null = weatherRefreshController.current;
  weatherRefreshController.current = null;
  controller?.abort();
}
