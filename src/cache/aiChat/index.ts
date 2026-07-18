import { resetAiChatCompactionCache } from "./compaction";
import { clearChatHeartbeatCache, resetAiChatHeartbeatCache } from "./heartbeat";
import { resetAiChatIdentityCache } from "./identity";
import { resetAiChatMemoryCache } from "./memory";
import { resetAiChatMoodCache } from "./mood";
import { invalidateChatReplyCache, resetAiChatReplyCache } from "./replies";

/** AI 禁用或记忆淘汰的统一运行时失效边界。压缩链不提前删除：代际已让旧
 * 结果失效，保留链到自然排空可防同群新旧压缩任务并发。 */
export function invalidateChatRuntimeCache(chatId: number): number {
  const generation: number = invalidateChatReplyCache(chatId);
  clearChatHeartbeatCache(chatId);
  return generation;
}

/** Worker dispose/测试隔离的全量清理边界；生产中的 Worker 重建由线程上下文
 * 销毁天然完成同样效果。 */
export function resetAiChatWorkerCache(): void {
  resetAiChatHeartbeatCache();
  resetAiChatCompactionCache();
  resetAiChatIdentityCache();
  resetAiChatMemoryCache();
  resetAiChatMoodCache();
  resetAiChatReplyCache();
}
