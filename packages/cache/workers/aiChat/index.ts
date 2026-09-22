import { resetAiChatCompactionCache } from "./compaction";
import { clearChatHeartbeatCache, resetAiChatHeartbeatCache } from "./heartbeat";
import { resetAiChatIdentityCache } from "./identity";
import { resetImageGenerationCache } from "./imageGeneration";
import { resetAiChatMemoryCache } from "./memory";
import { resetAiChatMoodCache } from "./mood";
import { resetAiProviderSchedulerCache } from "./providerScheduler";
import { invalidateChatReplyCache, resetAiChatReplyCache } from "./replies";
import { resetSongGenerationCache } from "./songGeneration";

/** AI 禁用或记忆淘汰的统一运行时失效边界。压缩链不提前删除：代际已让旧
 * 结果失效，保留链到自然排空可防同群新旧压缩任务并发。 */
export function invalidateChatRuntimeCache(chatId: number): void {
  invalidateChatReplyCache(chatId);
  clearChatHeartbeatCache(chatId);
}

/**
 * 本线程各领域缓存的全量清理边界。
 *
 * **只有测试隔离用它**：生产中 AI Worker 的重建就是换一个 isolate，线程上下文
 * 销毁天然完成同样效果，没有任何生产路径需要手工清空这九份表。运行期的按群
 * 失效走上面的 invalidateChatRuntimeCache。
 */
export function resetAiChatWorkerCache(): void {
  resetAiChatHeartbeatCache();
  resetAiChatCompactionCache();
  resetAiChatIdentityCache();
  resetImageGenerationCache();
  resetAiChatMemoryCache();
  resetAiChatMoodCache();
  resetAiProviderSchedulerCache();
  resetAiChatReplyCache();
  resetSongGenerationCache();
}
