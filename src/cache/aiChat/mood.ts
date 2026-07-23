import type { MoodOption } from "../../types/aiChat/mood";

/** 心情及其到期时刻都不落盘，随 Worker 重启清空、下次拼提示词时重抽。 */
export const chatMoods: Map<number, MoodOption> = new Map();
/** 各群当前心情到期时刻；与 chatMoods 同步填充和删除，Worker 重建后清空。 */
export const chatMoodExpiresAts: Map<number, number> = new Map();

/** 群 teardown 时同步删除心情与到期时刻。 */
export function clearChatMoodCache(chatId: number): void {
  chatMoods.delete(chatId);
  chatMoodExpiresAts.delete(chatId);
}

/** Worker dispose 或测试隔离时清空全部群心情状态。 */
export function resetAiChatMoodCache(): void {
  chatMoods.clear();
  chatMoodExpiresAts.clear();
}
