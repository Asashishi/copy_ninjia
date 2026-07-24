import type { ChatActionHeartbeatEntry } from "../../types/aiChat/chatAction";

/** 聊天状态心跳（src/ai/chatActionHeartbeat.ts）的内存状态。 */

/** chatId -> 共享聊天状态心跳；每个条目由同群全部在途回复轮引用计数。 */
export const typingHeartbeats: Map<number, ChatActionHeartbeatEntry> = new Map();

/** 禁用/淘汰时立即停止本群后续 tick。已发出的请求仍由原回复轮 stop/settle
 * 等待；从 Map 移除后旧句柄的 set 会自动失效，重新启用可安全创建新条目。 */
export function clearChatHeartbeatCache(chatId: number): void {
  const entry: ChatActionHeartbeatEntry | undefined = typingHeartbeats.get(chatId);
  if (!entry) return;
  clearInterval(entry.timer);
  entry.owner = null;
  entry.action = "idle";
  typingHeartbeats.delete(chatId);
}

/** Worker dispose/测试隔离时停止所有 timer 并清空表。 */
export function resetAiChatHeartbeatCache(): void {
  for (const chatId of [...typingHeartbeats.keys()]) clearChatHeartbeatCache(chatId);
}
