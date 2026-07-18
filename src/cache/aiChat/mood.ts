import type { MoodOption } from "../../types/aiChat/mood";

/** 心情及最后活动时间都不落盘；hydrate 只按 savedAt 重新播种一份新心情。 */
export const chatMoods: Map<number, MoodOption> = new Map();
export const chatLastActivityTimes: Map<number, number> = new Map();

export function clearChatMoodCache(chatId: number): void {
  chatMoods.delete(chatId);
  chatLastActivityTimes.delete(chatId);
}

export function resetAiChatMoodCache(): void {
  chatMoods.clear();
  chatLastActivityTimes.clear();
}
