import type { MoodOption } from "../../../types/aiChat/mood";

/** owner: workers/aiChat。AI 心情抽取与到期（packages/aiChat/ai/mood.ts）的内存状态；容量等于仍有当前
 * 心情的群数，群 teardown 与到期路径同步删除。 */

/**
 * 心情及其到期时刻都不落盘，随 Worker 重启清空、下次拼提示词时重抽。
 * 容量：仍有当前心情的群数，上界为受管群数（STATE_MANAGED_CHAT_LIMIT）；
 * 不设淘汰——条目由 clearChatMoodCache（群 teardown）与到期重抽路径回收。
 */
export const chatMoods: Map<number, MoodOption> = new Map();
/**
 * 各群当前心情到期时刻；与 chatMoods 同步填充和删除，Worker 重建后清空。
 * 容量与清理逐字跟随 chatMoods，两张表始终成对增删。
 */
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
