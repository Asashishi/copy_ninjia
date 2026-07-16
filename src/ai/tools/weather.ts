import { logger } from "../../infra/logger";
import {
  CACHE_TTL_MS,
  REQUEST_TIMEOUT_MS,
  TOKYO_LATITUDE,
  TOKYO_LONGITUDE,
  WEATHER_API_URL,
  WEATHER_CODE_DESCRIPTIONS,
} from "../../consts/weather";
import { weatherCache } from "../../cache/weather";
import { fetchJsonWithTimeout } from "../../libs/httpFetch";
import type { TokyoWeatherResult } from "../../types";

/**
 * AI 工具:获取东京今天的天气。用 Open-Meteo 的免费公开端点——不需要
 * API key，也没有调用额度限制，适合这种低频、非关键路径的场景。
 */

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `未知天气现象（代码 ${code}）`;
}

/**
 * 请求失败、超时或返回数据格式不对时返回 null，由调用方决定如何降级。
 * 命中缓存时直接返回缓存值，不发请求（有效期见 CACHE_TTL_MS）。
 */
export async function getTokyoWeather(): Promise<TokyoWeatherResult | null> {
  if (weatherCache.result && Date.now() - weatherCache.at < CACHE_TTL_MS) {
    return weatherCache.result;
  }

  const url: URL = new URL(WEATHER_API_URL);
  url.searchParams.set("latitude", String(TOKYO_LATITUDE));
  url.searchParams.set("longitude", String(TOKYO_LONGITUDE));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", "Asia/Tokyo");

  const data: any = await fetchJsonWithTimeout(url, {}, REQUEST_TIMEOUT_MS, "Open-Meteo API");
  if (data === null) return null;

  const currentTemperatureC: unknown = data?.current?.temperature_2m;
  const currentCode: unknown = data?.current?.weather_code;
  const todayMaxC: unknown = data?.daily?.temperature_2m_max?.[0];
  const todayMinC: unknown = data?.daily?.temperature_2m_min?.[0];
  const todayCode: unknown = data?.daily?.weather_code?.[0];

  if (
    typeof currentTemperatureC !== "number" ||
    typeof currentCode !== "number" ||
    typeof todayMaxC !== "number" ||
    typeof todayMinC !== "number" ||
    typeof todayCode !== "number"
  ) {
    logger.error("Open-Meteo API returned unexpected shape:", data);
    return null;
  }

  const result: TokyoWeatherResult = {
    currentTemperatureC,
    currentCondition: describeWeatherCode(currentCode),
    todayMaxC,
    todayMinC,
    todayCondition: describeWeatherCode(todayCode),
  };
  weatherCache.result = result;
  weatherCache.at = Date.now();
  return result;
}
