import type { TimeBucket, WeatherBucket } from "../../types/aiChat/mood";
import { exhaustiveList } from "../exhaustiveList";

/** 单条心情配置必须具有的字段，用于 config/mood.ts 的严格键校验。 */
export const MOOD_ENTRY_REQUIRED_KEYS: readonly string[] = ["name", "weight", "instruction"];
/** 单条心情配置允许额外出现的可选字段。 */
export const MOOD_ENTRY_OPTIONAL_KEYS: readonly string[] = ["weatherMultipliers", "timeMultipliers"];

/**
 * mood.json 全部 base weight 之和必须恰好等于的值，让配置里的权重可以直接当百分比读。
 * 抽取算法按倍率调整后的连续权重工作、不依赖总和。所属模块：config/mood.ts。
 */
export const MOOD_WEIGHT_TOTAL: number = 100;

/** 心情的随机寿命区间：抽到后过这么久自然到期重抽，与群是否活跃无关；
 *  心情与到期时刻均不落盘。 */
export const MOOD_REROLL_MIN_MS: number = 2 * 60 * 60_000;
/** 单次心情保持时长的随机上界。 */
export const MOOD_REROLL_MAX_MS: number = 4 * 60 * 60_000;

/** 心情查询/重抽命令等待 Worker 回执的超时（见 packages/aiChat/index.ts），
 *  同时用于生成请求的绝对截止时刻：Worker 侧同步完成、正常毫秒级返回，
 *  积压至截止时刻后的请求不再执行。 */
export const MOOD_REQUEST_TIMEOUT_MS: number = 5_000;

/**
 * 部署配置中单个天气/时段倍率的硬上限；超过时启动阶段拒绝，权重连乘与总和保持有限。
 */
export const MOOD_MULTIPLIER_MAX: number = 100;

/** 部署配置（config/dynamic/mood.json）倍率表允许使用的全部天气桶，供配置键校验。 */
export const WEATHER_BUCKETS: readonly WeatherBucket[] = exhaustiveList<WeatherBucket>()([
  "clear",
  "cloudy",
  "rain",
  "snow",
  "storm",
  "fog",
]);
/** 部署配置倍率表允许使用的全部配置时区时段桶，供配置键校验。 */
export const TIME_BUCKETS: readonly TimeBucket[] = exhaustiveList<TimeBucket>()([
  "lateNight",
  "morning",
  "daytime",
  "evening",
  "night",
]);
