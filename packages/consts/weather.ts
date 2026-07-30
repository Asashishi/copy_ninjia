/** 东京天气服务（packages/aiChat/ai/weather.ts）的调参常量。天气数据由 get_tokyo_weather
 *  工具与心情系统（aiChat/ai/mood.ts）共用，两边都只读缓存，不各自发请求。 */

/** Open-Meteo 请求使用的东京纬度。 */
export const TOKYO_LATITUDE: number = 35.6895;
/** Open-Meteo 请求使用的东京经度。 */
export const TOKYO_LONGITUDE: number = 139.6917;
/** 东京天气请求使用的 Open-Meteo 公开端点。 */
export const WEATHER_API_URL: string = "https://api.open-meteo.com/v1/forecast";
/** 单次 Open-Meteo 请求的超时预算。 */
export const WEATHER_REQUEST_TIMEOUT_MS: number = 10_000;

/** 后台定时刷新东京天气缓存的间隔：每小时一次，由 aiChat/ai/weather.ts 的
 *  startWeatherRefreshLoop 发起，是全进程唯一会真正打 Open-Meteo 接口的
 *  地方。 */
export const WEATHER_REFRESH_INTERVAL_MS: number = 60 * 60 * 1_000;

/** WMO 天气代码 -> 中文描述，覆盖 Open-Meteo 会返回的全部取值；被 aiChat/ai/mood.ts 与
 *  aiChat/ai/weather.ts 共用，冻结防止一方误改动影响另一方。 */
export const WEATHER_CODE_DESCRIPTIONS: Readonly<Record<number, string>> = Object.freeze({
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
});
