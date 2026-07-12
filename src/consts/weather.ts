/** 东京天气工具（src/tools/weather.ts）的调参常量。 */

export const TOKYO_LATITUDE: number = 35.6895;
export const TOKYO_LONGITUDE: number = 139.6917;
export const WEATHER_API_URL: string = "https://api.open-meteo.com/v1/forecast";
export const REQUEST_TIMEOUT_MS: number = 10_000;

/** 天气缓存有效期：1 小时内的重复请求直接复用，不打端点。 */
export const CACHE_TTL_MS: number = 60 * 60 * 1_000;

/** WMO 天气代码 -> 中文描述，覆盖 Open-Meteo 会返回的全部取值。 */
export const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
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
