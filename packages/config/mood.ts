import { defaultMoodConfigCache } from "../cache/perThread/config";
import {
  MOOD_ENTRY_OPTIONAL_KEYS,
  MOOD_ENTRY_REQUIRED_KEYS,
  MOOD_MULTIPLIER_MAX,
  TIME_BUCKETS,
  WEATHER_BUCKETS,
} from "../consts/aiChat/mood";
import { MOOD_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../libs/runtimeConfig";
import type { MoodOption, TimeBucket, WeatherBucket } from "../types/aiChat/mood";
import type { MoodConfig } from "../types/config";

/** 解码倍率表：键必须是对应维度的合法桶名，倍率必须是正有限数——
 *  computeAdjustedWeight 假定倍率乘完权重仍为正（见 aiChat/ai/mood.ts）。
 *  @param context 报错定位串，如 `weatherMultipliers of "开心"`。 */
interface MultiplierParseOptions<Bucket extends string> {
  readonly allowedBuckets: readonly Bucket[];
  readonly fieldPath: string;
  readonly sourcePath: string;
}

function parseMultipliers<Bucket extends string>(
  value: unknown,
  { allowedBuckets, fieldPath, sourcePath }: MultiplierParseOptions<Bucket>
): Partial<Record<Bucket, number>> {
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, fieldPath, "an object keyed by supported buckets");
  }
  const allowed: ReadonlySet<string> = new Set(allowedBuckets);
  const multipliers: Partial<Record<Bucket, number>> = Object.create(null) as Partial<Record<Bucket, number>>;
  for (const [bucket, multiplier] of Object.entries(value)) {
    if (!allowed.has(bucket)) {
      return invalidInput(sourcePath, `${fieldPath}.<key>`, "a supported bucket name");
    }
    if (
      typeof multiplier !== "number" ||
      !Number.isFinite(multiplier) ||
      multiplier <= 0 ||
      multiplier > MOOD_MULTIPLIER_MAX
    ) {
      return invalidInput(
        sourcePath,
        `${fieldPath}.<value>`,
        `a positive finite number no greater than ${MOOD_MULTIPLIER_MAX}`
      );
    }
    multipliers[bucket as Bucket] = multiplier;
  }
  return multipliers;
}

/** 解码单个心情档位；必填字段缺失、未知字段和非法取值都在启动阶段直接报错。 */
function parseMoodOption(value: unknown, index: number, sourcePath: string): MoodOption {
  const fieldPath: string = `$.moods[${index}]`;
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, fieldPath, "a mood object");
  }
  const knownKeys: ReadonlySet<string> = new Set([...MOOD_ENTRY_REQUIRED_KEYS, ...MOOD_ENTRY_OPTIONAL_KEYS]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) return invalidInput(sourcePath, `${fieldPath}.<key>`, "a current mood schema field");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    return invalidInput(sourcePath, `${fieldPath}.name`, "a non-empty string");
  }
  if (typeof value.weight !== "number" || !Number.isInteger(value.weight) || value.weight <= 0) {
    return invalidInput(sourcePath, `${fieldPath}.weight`, "a positive integer");
  }
  if (typeof value.instruction !== "string" || value.instruction.trim().length === 0) {
    return invalidInput(sourcePath, `${fieldPath}.instruction`, "a non-empty string");
  }

  const mood: MoodOption = {
    name: value.name,
    weight: value.weight,
    instruction: value.instruction,
    ...(value.weatherMultipliers !== undefined
      ? { weatherMultipliers: parseMultipliers<WeatherBucket>(value.weatherMultipliers, {
        allowedBuckets: WEATHER_BUCKETS,
        fieldPath: `${fieldPath}.weatherMultipliers`,
        sourcePath,
      }) }
      : {}),
    ...(value.timeMultipliers !== undefined
      ? { timeMultipliers: parseMultipliers<TimeBucket>(value.timeMultipliers, {
        allowedBuckets: TIME_BUCKETS,
        fieldPath: `${fieldPath}.timeMultipliers`,
        sourcePath,
      }) }
      : {}),
  };
  return mood;
}

/**
 * 穷举配置能进入的全部天气/时段组合，确保每个调整权重和累计总权重都有限。
 * 当前倍率上限已把数值控制在安全范围内；这层校验保留为抽选算法的直接契约。
 */
function validateAdjustedWeights(moods: readonly MoodOption[], sourcePath: string): void {
  const weatherBuckets: readonly (WeatherBucket | null)[] =
    [null, ...WEATHER_BUCKETS];
  for (const weather of weatherBuckets) {
    for (const time of TIME_BUCKETS) {
      let totalWeight: number = 0;
      for (const mood of moods) {
        const weatherMultiplier: number =
          weather === null ? 1 : mood.weatherMultipliers?.[weather] ?? 1;
        const timeMultiplier: number = mood.timeMultipliers?.[time] ?? 1;
        const adjustedWeight: number =
          mood.weight * weatherMultiplier * timeMultiplier;
        if (!Number.isFinite(adjustedWeight) || adjustedWeight <= 0) {
          return invalidInput(sourcePath, "$.moods", "finite positive adjusted weights for every bucket combination");
        }
        totalWeight += adjustedWeight;
      }
      if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        return invalidInput(sourcePath, "$.moods", "a finite positive total weight for every bucket combination");
      }
    }
  }
}

/** 严格解码 mood.json；base weight 必须是正整数且总和恰好为 100（抽取算法
 *  本身按倍率调整后的连续权重工作、不依赖总和，恒等 100 是为了让配置里的
 *  权重可以直接当百分比读；限定整数让总和判断走精确的整数算术，没有
 *  浮点误差）。 */
export function parseMoodConfig(
  value: unknown,
  sourcePath: string = MOOD_CONFIG_PATH
): MoodConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["moods"]) || !Array.isArray(value.moods)) {
    return invalidInput(sourcePath, "$", "exactly { moods: MoodOption[] }");
  }
  if (value.moods.length === 0) return invalidInput(sourcePath, "$.moods", "a non-empty array");

  const seen: Set<string> = new Set();
  const moods: MoodOption[] = value.moods.map((entry: unknown, index: number): MoodOption => {
    const mood: MoodOption = parseMoodOption(entry, index, sourcePath);
    if (seen.has(mood.name)) return invalidInput(sourcePath, `$.moods[${index}].name`, "unique");
    seen.add(mood.name);
    return mood;
  });

  const weightSum: number = moods.reduce((sum: number, mood: MoodOption): number => sum + mood.weight, 0);
  if (weightSum !== 100) {
    return invalidInput(sourcePath, "$.moods[*].weight", "positive integers summing to 100");
  }
  validateAdjustedWeights(moods, sourcePath);
  return { moods };
}

/** 从指定文件加载并校验；模块 import 本身不访问文件系统。 */
export function loadMoodConfig(path: string = MOOD_CONFIG_PATH): MoodConfig {
  return parseMoodConfig(readJsonInput(path), path);
}

/**
 * 默认部署配置按进程/Worker 惰性缓存。主进程启动总闸会校验已存在的文件；
 * 真正缺省时仍由功能 readiness 决定该功能能否开启。
 */
export function getMoodConfig(): MoodConfig {
  defaultMoodConfigCache.current ??= loadMoodConfig();
  return defaultMoodConfigCache.current;
}
