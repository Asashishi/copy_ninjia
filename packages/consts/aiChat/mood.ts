import type { TimeBucket, WeatherBucket } from "../../types/aiChat/mood";

/** 单条心情配置必须具有的字段，用于 config/mood.ts 的严格键校验。 */
export const MOOD_ENTRY_REQUIRED_KEYS: readonly string[] = Object.freeze(["name", "weight", "instruction"]);
/** 单条心情配置允许额外出现的可选字段。 */
export const MOOD_ENTRY_OPTIONAL_KEYS: readonly string[] = Object.freeze(["weatherMultipliers", "timeMultipliers"]);

/** 心情的随机寿命区间：抽到后过这么久自然到期重抽，与群是否活跃无关；
 *  心情与到期时刻均不落盘。 */
export const MOOD_REROLL_MIN_MS: number = 2 * 60 * 60_000;
/** 单次心情保持时长的随机上界。 */
export const MOOD_REROLL_MAX_MS: number = 4 * 60 * 60_000;

/** /switch_mood 主线程等待 Worker moodSwitched 回执的超时（见 packages/aiChat/index.ts 的
 *  switchAiMood），同时用于生成请求的绝对截止时刻：重抽在 Worker 侧同步
 *  完成、正常毫秒级返回，积压至截止时刻后的请求不得再改写群心情。 */
export const MOOD_SWITCH_TIMEOUT_MS: number = 5_000;

// 天气/时段桶的运行时全集，供部署配置（config/mood.json）的倍率表键做运行时
// 校验。从 satisfies Record<Bucket, true> 的键派生而非手写数组：
// types/aiChat/mood.ts 的联合类型增删桶而这里没跟上时直接编译报错，不靠人工同步。
/** 天气桶联合类型的运行时全集，用于配置键校验。 */
const WEATHER_BUCKET_FLAGS: Readonly<Record<WeatherBucket, true>> = Object.freeze({
  clear: true,
  cloudy: true,
  rain: true,
  snow: true,
  storm: true,
  fog: true,
});
/** 部署配置允许使用的全部天气桶。 */
export const WEATHER_BUCKETS: readonly WeatherBucket[] = Object.freeze(Object.keys(WEATHER_BUCKET_FLAGS) as WeatherBucket[]);
/** 时段桶联合类型的运行时全集，用于配置键校验。 */
const TIME_BUCKET_FLAGS: Readonly<Record<TimeBucket, true>> = Object.freeze({
  lateNight: true,
  morning: true,
  daytime: true,
  evening: true,
  night: true,
});
/** 部署配置允许使用的全部东京时段桶。 */
export const TIME_BUCKETS: readonly TimeBucket[] = Object.freeze(Object.keys(TIME_BUCKET_FLAGS) as TimeBucket[]);
