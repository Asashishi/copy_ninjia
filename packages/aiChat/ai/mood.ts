import { chatMoodExpiresAts, chatMoods } from "../../cache/workers/aiChat/mood";
import { getMoodConfig } from "../../config/mood";
import { MOOD_REROLL_MAX_MS, MOOD_REROLL_MIN_MS } from "../../consts/aiChat/mood";
import { WEATHER_CODE_DESCRIPTIONS } from "../../consts/weather";
import { getTokyoHour } from "../../libs/time";
import { currentTokyoWeather } from "./weather";
import type { MoodOption, TimeBucket, WeatherBucket } from "../../types/aiChat/mood";

/** 按当前天气/时段调整过权重的候选心情，仅用于 pickMood 的一次抽选。 */
interface WeightedMood {
  mood: MoodOption;
  weight: number;
}

/**
 * 各群「心情」系统：心情只随时间自然轮换——抽到一个心情后带一个随机
 * 寿命（区间见 consts/aiChat/mood.ts），到期后下次拼提示词时重抽，与群里
 * 是否有人说话无关。重抽时按当前天气/时段微调各心情的抽中概率（大晴天
 * 更容易开心、雨天雷雨天更容易忧郁伤心、深夜更容易犯困，等等）。心情档位
 * 的文案、base weight 与倍率来自部署配置 config/mood.json（严格解码见
 * config/mood.ts，主进程持锁后预热、Worker 首次抽取时惰性加载）。两个内存缓存
 * （chatMoods/chatMoodExpiresAts，见 cache/workers/aiChat/mood.ts）都不落盘，
 * 随 Worker 重启清空、下次用到时重抽。
 *
 * 天气数据经 aiChat/ai/weather.ts 的 currentTokyoWeather 读取——这里只读现有
 * 缓存，不在这条路径里发请求（重抽发生在 replyModel.ts 拼系统提示词的
 * 同步路径上，必须保持同步）；缓存保鲜由该模块内部的后台
 * 定时循环负责（每小时刷新一次，见 startWeatherRefreshLoop），与
 * get_tokyo_weather 工具共用同一份数据、同一种「只读不发请求」的取用
 * 方式。缓存还没暖起来（Worker 刚启动、还没到第一次刷新）时按「没有
 * 天气影响」处理，不阻塞、不强行现查一次。
 */

/** 天气描述文案 -> 粗粒度天气桶：由 WEATHER_CODE_DESCRIPTIONS 反向推导，
 *  保证分类口径与天气服务本身完全一致，不会各改各的漂移。
 *  currentTokyoWeather 给心情系统能拿到的只有格式化后的中文描述
 *  （TokyoWeatherResult 没有保留原始 WMO 代码，那是特意精简给模型看的
 *  字段），所以按描述文案反查桶。 */
const WEATHER_DESCRIPTION_TO_BUCKET: Record<string, WeatherBucket> = Object.fromEntries(
  Object.entries(WEATHER_CODE_DESCRIPTIONS).map(([code, description]: [string, string]): [string, WeatherBucket] => [description, classifyWeatherCodeBucket(Number(code))])
);

/** 按 WMO 天气代码归类到粗粒度天气桶，覆盖范围与 WEATHER_CODE_DESCRIPTIONS
 *  一致；95/96/99（雷雨）穷举完前面几类后归到兜底的 storm。导出仅为可
 *  测试性。 */
export function classifyWeatherCodeBucket(code: number): WeatherBucket {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  return "storm";
}

/** 按东京时区小时数（0~23）归类到粗粒度时段桶。导出仅为可测试性。 */
export function classifyTimeBucket(hour: number): TimeBucket {
  if (hour < 5) return "lateNight";
  if (hour < 9) return "morning";
  if (hour < 18) return "daytime";
  if (hour < 22) return "evening";
  return "night";
}

/** 当前天气分桶：经 aiChat/ai/weather.ts 的 currentTokyoWeather 读取，缓存为空
 *  （还没到第一次定时刷新）时返回 null，视为「没有天气影响」。 */
function currentWeatherBucket(): WeatherBucket | null {
  const condition: string | undefined = currentTokyoWeather()?.currentCondition;
  return condition ? WEATHER_DESCRIPTION_TO_BUCKET[condition] ?? null : null;
}

/** 某个心情在给定天气/时段下调整后的权重：base weight 分别乘上天气倍率、
 *  时段倍率（桶不在对应表里则该维度按 ×1）。下限 0.01 只是防御性兜底
 *  （配置里的倍率都是正数，理论上乘出来不会 <= 0），避免万一配置疏漏
 *  导致某一档彻底摇不到、还搞坏累加匹配。导出仅为可测试性。 */
export function computeAdjustedWeight(mood: MoodOption, weather: WeatherBucket | null, time: TimeBucket): number {
  const weatherMultiplier: number = weather ? mood.weatherMultipliers?.[weather] ?? 1 : 1;
  const timeMultiplier: number = mood.timeMultipliers?.[time] ?? 1;
  return Math.max(mood.weight * weatherMultiplier * timeMultiplier, 0.01);
}

/**
 * 按当前天气/时段调整过的权重表抽一个心情：现查一次天气分桶与时段分桶，
 * 把 config/mood.json 各档位的 base weight 逐个按各自倍率调整后，在
 * [0, 调整后总权重) 里掷一个连续骰子累加匹配——不再是 LUCK_TIERS 那种
 * 凑满 100 的固定整数区间，因为倍率之后权重不再是整数、总和也不再是 100。
 */
function pickMood(): MoodOption {
  const weather: WeatherBucket | null = currentWeatherBucket();
  const time: TimeBucket = classifyTimeBucket(getTokyoHour());
  const weighted: WeightedMood[] = getMoodConfig().moods.map((mood: MoodOption): WeightedMood => ({
    mood,
    weight: computeAdjustedWeight(mood, weather, time),
  }));
  const totalWeight: number = weighted.reduce((sum: number, entry: WeightedMood): number => sum + entry.weight, 0);
  const roll: number = Math.random() * totalWeight;
  let cumulative: number = 0;
  for (const entry of weighted) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry.mood;
  }
  return weighted[weighted.length - 1]!.mood;
}

/**
 * 立即重抽某群的心情并写回缓存：无视剩余寿命强制换一次，给新心情掷一个
 * 新的随机寿命。自然到期重抽（下方 currentMood）与 /switch_mood
 * 手动切换（aiChatWorker.ts 的 switchMood 消息路由）共用这一条路径。
 * @param chatId 群聊 ID。
 * @param moods/expiresAts 可注入仅为单测隔离；生产调用共享 Worker 内的
 *   chatMoods/chatMoodExpiresAts（见 cache/workers/aiChat/mood.ts）。
 */
export function switchMood(
  chatId: number,
  moods: Map<number, MoodOption> = chatMoods,
  expiresAts: Map<number, number> = chatMoodExpiresAts
): MoodOption {
  const mood: MoodOption = pickMood();
  moods.set(chatId, mood);
  expiresAts.set(chatId, Date.now() + MOOD_REROLL_MIN_MS + Math.random() * (MOOD_REROLL_MAX_MS - MOOD_REROLL_MIN_MS));
  return mood;
}

/**
 * 读取某群当前有效心情。心情缺失（本群第一次用到、或 Worker 重启后缓存
 * 清空）或已过寿命时按自然轮换规则现场重抽；未到期时绝不强制切换。
 * @param chatId 群聊 ID。
 * @param moods/expiresAts 可注入仅为单测隔离；生产调用共享 Worker 内的
 *   chatMoods/chatMoodExpiresAts（见 cache/workers/aiChat/mood.ts）。
 */
export function currentMood(
  chatId: number,
  moods: Map<number, MoodOption> = chatMoods,
  expiresAts: Map<number, number> = chatMoodExpiresAts
): MoodOption {
  const now: number = Date.now();
  let mood: MoodOption | undefined = moods.get(chatId);
  if (!mood || now >= (expiresAts.get(chatId) ?? 0)) {
    mood = switchMood(chatId, moods, expiresAts);
  }
  return mood;
}

/**
 * 拼进系统提示词的当前心情指令；当前档位及自然到期语义统一由 currentMood
 * 维护，避免查询命令与提示词拼装各自实现一遍缓存读取。
 */
export function currentMoodInstruction(
  chatId: number,
  moods: Map<number, MoodOption> = chatMoods,
  expiresAts: Map<number, number> = chatMoodExpiresAts
): string {
  const mood: MoodOption = currentMood(chatId, moods, expiresAts);
  return `【今天的心情：${mood.name}】${mood.instruction}`;
}
