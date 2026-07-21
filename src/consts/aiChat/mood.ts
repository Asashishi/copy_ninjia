import type { TimeBucket, WeatherBucket } from "../../types/aiChat/mood";

/** 心情的随机寿命区间：抽到后过这么久自然到期重抽，与群是否活跃无关；
 *  心情与到期时刻均不落盘。 */
export const MOOD_REROLL_MIN_MS: number = 2 * 60 * 60_000;
export const MOOD_REROLL_MAX_MS: number = 4 * 60 * 60_000;

// 天气/时段桶的运行时全集，供部署配置（config/mood.json）的倍率表键做运行时
// 校验。从 satisfies Record<Bucket, true> 的键派生而非手写数组：
// types/aiChat/mood.ts 的联合类型增删桶而这里没跟上时直接编译报错，不靠人工同步。
const WEATHER_BUCKET_FLAGS = { clear: true, cloudy: true, rain: true, snow: true, storm: true, fog: true } satisfies Record<WeatherBucket, true>;
export const WEATHER_BUCKETS: readonly WeatherBucket[] = Object.freeze(Object.keys(WEATHER_BUCKET_FLAGS) as WeatherBucket[]);
const TIME_BUCKET_FLAGS = { lateNight: true, morning: true, daytime: true, evening: true, night: true } satisfies Record<TimeBucket, true>;
export const TIME_BUCKETS: readonly TimeBucket[] = Object.freeze(Object.keys(TIME_BUCKET_FLAGS) as TimeBucket[]);
