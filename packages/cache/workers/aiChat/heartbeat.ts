import type { ChatActionHeartbeatEntry } from "../../../types/aiChat/chatAction";

/** 聊天状态心跳（packages/aiChat/ai/chatActionHeartbeat.ts）的内存状态；容量不超过
 * 同时存在回复轮的群数，Worker 重建后从空表开始。 */

/**
 * chatId -> 共享聊天状态心跳；每个条目由同群全部在途回复轮引用计数。
 * 清理：clearChatHeartbeatCache（引用归零、群失效、AI 禁用）与
 * resetAiChatHeartbeatCache（Worker dispose/测试隔离）各自 clearInterval 后删键。
 * 容量：同时存在回复轮的群数，上界为受管群数；不设淘汰——条目持有一个活跃
 * timer，按容量丢掉会让那个 timer 永远停不下来。
 */
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
