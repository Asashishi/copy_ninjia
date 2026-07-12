import { logger } from "../logger";

/**
 * AI 工具:获取东京今天的天气。用 Open-Meteo 的免费公开端点——不需要
 * API key，也没有调用额度限制，适合这种低频、非关键路径的场景。
 */

const TOKYO_LATITUDE: number = 35.6895;
const TOKYO_LONGITUDE: number = 139.6917;
const WEATHER_API_URL: string = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS: number = 10_000;

/** 天气缓存有效期：1 小时内的重复请求直接复用，不打端点。 */
const CACHE_TTL_MS: number = 60 * 60 * 1_000;

/** 进程内内存缓存，仅存最近一次成功结果（失败不缓存，下次照常重试）。 */
let cachedResult: TokyoWeatherResult | null = null;
let cachedAt: number = 0;

/** WMO 天气代码 -> 中文描述，覆盖 Open-Meteo 会返回的全部取值。 */
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "晴朗",
  1: "大致晴朗",
  2: "局部多云",
  3: "阴天",
  45: "雾",
  48: "冻雾",
  51: "小毛毛雨",
  53: "中等毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨（弱）",
  57: "冻毛毛雨（强）",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨（弱）",
  67: "冻雨（强）",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "米雪",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷雨",
  96: "雷雨伴小冰雹",
  99: "雷雨伴大冰雹",
};

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `未知天气现象（代码 ${code}）`;
}

export interface TokyoWeatherResult {
  currentTemperatureC: number;
  currentCondition: string;
  todayMaxC: number;
  todayMinC: number;
  todayCondition: string;
}

/**
 * 请求失败、超时或返回数据格式不对时返回 null，由调用方决定如何降级。
 * 命中缓存（1 小时内）时直接返回缓存值，不发请求。
 */
export async function getTokyoWeather(): Promise<TokyoWeatherResult | null> {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const controller: AbortController = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const url: URL = new URL(WEATHER_API_URL);
  url.searchParams.set("latitude", String(TOKYO_LATITUDE));
  url.searchParams.set("longitude", String(TOKYO_LONGITUDE));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", "Asia/Tokyo");

  try {
    const response: Response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      logger.error(`Open-Meteo API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const data: any = await response.json();
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
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  } catch (error: unknown) {
    logger.error("Error calling Open-Meteo API:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
