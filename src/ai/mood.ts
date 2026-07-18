import { chatLastActivityTimes, chatMoods } from "../cache/aiChatWorker";
import { MOOD_IDLE_RESET_MAX_MS, MOOD_IDLE_RESET_MIN_MS } from "../consts/aiChat";
import { MOOD_OPTIONS } from "../consts/aiChatPrompts";
import { WEATHER_CODE_DESCRIPTIONS } from "../consts/weather";
import { getTokyoHour } from "../libs/time";
import { currentTokyoWeather } from "./weather";
import type { MoodOption, TimeBucket, WeatherBucket } from "../types";

/**
 * 各群「心情」系统：模拟真人聊天号那种「隔了好久没说话，再冒泡时状态
 * 可能不一样了」的感觉，重抽时还会按当前天气/时段微调各心情的抽中概率
 * （大晴天更容易开心、雨天雷雨天更容易忧郁伤心、深夜更容易犯困，等等，
 * 具体倍率见 consts/aiChatPrompts.ts 的 MOOD_OPTIONS）。两个内存缓存
 * （chatMoods/chatLastActivityTimes，见 cache/aiChatWorker.ts）都不落盘，
 * 随 Worker 重启清空。
 *
 * 天气数据经 ai/weather.ts 的 currentTokyoWeather 读取——这里只读现有
 * 缓存，不在这条路径里发请求（重抽必须保持同步，见下方
 * recordActivityAndMaybeRerollMood 注释）；缓存保鲜由该模块内部的后台
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
  Object.entries(WEATHER_CODE_DESCRIPTIONS).map(([code, description]) => [description, classifyWeatherCodeBucket(Number(code))])
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

/** 当前天气分桶：经 ai/weather.ts 的 currentTokyoWeather 读取，缓存为空
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
 * 把 MOOD_OPTIONS 的 base weight 逐个按各自倍率调整后，在
 * [0, 调整后总权重) 里掷一个连续骰子累加匹配——不再是 LUCK_TIERS 那种
 * 凑满 100 的固定整数区间，因为倍率之后权重不再是整数、总和也不再是 100。
 */
function pickMood(): MoodOption {
  const weather: WeatherBucket | null = currentWeatherBucket();
  const time: TimeBucket = classifyTimeBucket(getTokyoHour());
  const weighted: { mood: MoodOption; weight: number }[] = MOOD_OPTIONS.map((mood) => ({
    mood,
    weight: computeAdjustedWeight(mood, weather, time),
  }));
  const totalWeight: number = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const roll: number = Math.random() * totalWeight;
  let cumulative: number = 0;
  for (const entry of weighted) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry.mood;
  }
  return weighted[weighted.length - 1]!.mood;
}

/**
 * 每次有消息记入某个群的滚动缓存时调用一次（不论文字/媒体、也不论是否
 * 触发了 AI 回复，见 workers/aiChatWorker.ts 的 pushBufferedMessage）：
 * 更新该群「最后一次有动静」的时间戳，并按空窗规则决定要不要重新抽一次
 * 心情。必须在真正记录这条消息之前调用——判断的是「这条消息之前」的
 * 空窗时长，若先把这条消息自己的时间戳记成 lastActivity 再判断，空窗
 * 永远算不出来。
 * @param chatId 群聊 ID。
 * @param moods/lastActivityTimes 可注入仅为单测隔离；生产调用共享 Worker
 *   内的 chatMoods/chatLastActivityTimes（见 cache/aiChatWorker.ts）。
 */
export function recordActivityAndMaybeRerollMood(
  chatId: number,
  moods: Map<number, MoodOption> = chatMoods,
  lastActivityTimes: Map<number, number> = chatLastActivityTimes
): void {
  const now: number = Date.now();
  const lastActivity: number | undefined = lastActivityTimes.get(chatId);
  lastActivityTimes.set(chatId, now);

  if (lastActivity === undefined) {
    // 本群第一次有动静（或 Worker 刚重启、缓存清空后的第一条消息），
    // 还没有心情，直接抽一次。
    moods.set(chatId, pickMood());
    return;
  }
  const idleThresholdMs: number = MOOD_IDLE_RESET_MIN_MS + Math.random() * (MOOD_IDLE_RESET_MAX_MS - MOOD_IDLE_RESET_MIN_MS);
  if (now - lastActivity >= idleThresholdMs) {
    moods.set(chatId, pickMood());
  }
}

/**
 * 拼进系统提示词的当前心情指令。moods 里没有记录时返回空串（理论上不会
 * 发生：任何触发都对应一条已经先经 recordActivityAndMaybeRerollMood 记录
 * 过的消息，见 workers/aiChatWorker.ts 的 callGemini 调用点），系统提示词
 * 就少这一段，不必因为这种防御性场景多包一层判断。
 * @param moods 可注入仅为单测隔离；生产调用共享 Worker 内的 chatMoods。
 */
export function currentMoodInstruction(chatId: number, moods: Map<number, MoodOption> = chatMoods): string {
  const mood: MoodOption | undefined = moods.get(chatId);
  if (!mood) return "";
  return `【今天的心情：${mood.name}】${mood.instruction}`;
}
