import type { MoodOption } from "../../types/aiChat/mood";

/** 心情及其到期时刻都不落盘，随 Worker 重启清空、下次拼提示词时重抽。 */
export const chatMoods: Map<number, MoodOption> = new Map();
export const chatMoodExpiresAts: Map<number, number> = new Map();

export function clearChatMoodCache(chatId: number): void {
  chatMoods.delete(chatId);
  chatMoodExpiresAts.delete(chatId);
}

export function resetAiChatMoodCache(): void {
  chatMoods.clear();
  chatMoodExpiresAts.clear();
}
