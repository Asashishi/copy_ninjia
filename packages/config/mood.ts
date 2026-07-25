import { readFileSync } from "node:fs";
import { defaultMoodConfigCache } from "../cache/config";
import {
  MOOD_ENTRY_OPTIONAL_KEYS,
  MOOD_ENTRY_REQUIRED_KEYS,
  TIME_BUCKETS,
  WEATHER_BUCKETS,
} from "../consts/aiChat/mood";
import { MOOD_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { MoodOption, TimeBucket, WeatherBucket } from "../types/aiChat/mood";

export interface MoodConfig {
  readonly moods: readonly MoodOption[];
}

/** 解码倍率表：键必须是对应维度的合法桶名，倍率必须是正有限数——
 *  computeAdjustedWeight 假定倍率乘完权重仍为正（见 ai/mood.ts）。
 *  @param context 报错定位串，如 `weatherMultipliers of "开心"`。 */
function parseMultipliers<Bucket extends string>(
  value: unknown,
  allowedBuckets: readonly Bucket[],
  context: string
): Partial<Record<Bucket, number>> {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid mood config: ${context} must be an object`);
  }
  const allowed: ReadonlySet<string> = new Set(allowedBuckets);
  const multipliers: Partial<Record<Bucket, number>> = Object.create(null) as Partial<Record<Bucket, number>>;
  for (const [bucket, multiplier] of Object.entries(value)) {
    if (!allowed.has(bucket)) {
      throw new Error(`Unknown bucket in ${context}: ${JSON.stringify(bucket)}`);
    }
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`Invalid multiplier for ${JSON.stringify(bucket)} in ${context}: expected a positive finite number`);
    }
    multipliers[bucket as Bucket] = multiplier;
  }
  return Object.freeze(multipliers);
}

/** 解码单个心情档位；必填字段缺失、未知字段和非法取值都在启动阶段直接报错。 */
function parseMoodOption(value: unknown, index: number): MoodOption {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid mood config entry at index ${index}: expected an object`);
  }
  const knownKeys: ReadonlySet<string> = new Set([...MOOD_ENTRY_REQUIRED_KEYS, ...MOOD_ENTRY_OPTIONAL_KEYS]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) throw new Error(`Unknown key in mood config entry at index ${index}: ${JSON.stringify(key)}`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error(`Invalid mood config entry at index ${index}: name must be a non-empty string`);
  }
  if (typeof value.weight !== "number" || !Number.isInteger(value.weight) || value.weight <= 0) {
    throw new Error(`Invalid mood config entry ${JSON.stringify(value.name)}: weight must be a positive integer`);
  }
  if (typeof value.instruction !== "string" || value.instruction.trim().length === 0) {
    throw new Error(`Invalid mood config entry ${JSON.stringify(value.name)}: instruction must be a non-empty string`);
  }

  const mood: MoodOption = {
    name: value.name,
    weight: value.weight,
    instruction: value.instruction,
    ...(value.weatherMultipliers !== undefined
      ? { weatherMultipliers: parseMultipliers<WeatherBucket>(value.weatherMultipliers, WEATHER_BUCKETS, `weatherMultipliers of ${JSON.stringify(value.name)}`) }
      : {}),
    ...(value.timeMultipliers !== undefined
      ? { timeMultipliers: parseMultipliers<TimeBucket>(value.timeMultipliers, TIME_BUCKETS, `timeMultipliers of ${JSON.stringify(value.name)}`) }
      : {}),
  };
  return Object.freeze(mood);
}

/** 严格解码 mood.json；base weight 必须是正整数且总和恰好为 100（抽取算法
 *  本身按倍率调整后的连续权重工作、不依赖总和，恒等 100 是为了让配置里的
 *  权重可以直接当百分比读；限定整数让总和判断走精确的整数算术，没有
 *  浮点误差）。 */
export function parseMoodConfig(value: unknown): MoodConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["moods"]) || !Array.isArray(value.moods)) {
    throw new Error("Invalid mood config: expected exactly { moods: MoodOption[] }");
  }
  if (value.moods.length === 0) throw new Error("Invalid mood config: moods must not be empty");

  const seen: Set<string> = new Set();
  const moods: MoodOption[] = value.moods.map((entry: unknown, index: number): MoodOption => {
    const mood: MoodOption = parseMoodOption(entry, index);
    if (seen.has(mood.name)) throw new Error(`Duplicate mood config entry name: ${mood.name}`);
    seen.add(mood.name);
    return mood;
  });

  const weightSum: number = moods.reduce((sum: number, mood: MoodOption): number => sum + mood.weight, 0);
  if (weightSum !== 100) {
    throw new Error(`Mood config weights must sum to 100, got ${weightSum}`);
  }
  return Object.freeze({ moods: Object.freeze(moods) });
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadMoodConfig(path: string = MOOD_CONFIG_PATH): MoodConfig {
  return parseMoodConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** 默认部署配置按进程/Worker 惰性加载一次。主进程会在取得实例锁后预先调用。 */
export function getMoodConfig(): MoodConfig {
  defaultMoodConfigCache.current ??= loadMoodConfig();
  return defaultMoodConfigCache.current;
}
