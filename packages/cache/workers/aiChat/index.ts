import { clearChatBotImageCache, resetAiChatBotImageCache } from "./botImages";
import { resetAiChatCompactionCache } from "./compaction";
import { resetGeminiContextCache } from "./geminiContextCache";
import { clearChatHeartbeatCache, resetAiChatHeartbeatCache } from "./heartbeat";
import { resetAiChatIdentityCache } from "./identity";
import { resetImageGenerationCache } from "./imageGeneration";
import { resetAiChatMemoryCache } from "./memory";
import { resetAiChatMoodCache } from "./mood";
import { resetAiProviderSchedulerCache } from "./providerScheduler";
import { invalidateChatReplyCache, resetAiChatReplyCache } from "./replies";

/** owner: workers/aiChat。本文件不持有状态，只聚合本线程各领域缓存模块的失效与清理边界。 */

/** AI 禁用或记忆淘汰的统一运行时失效边界。压缩链不提前删除：代际已让旧
 * 结果失效，保留链到自然排空可防同群新旧压缩任务并发。 */
export function invalidateChatRuntimeCache(chatId: number): void {
  invalidateChatReplyCache(chatId);
  clearChatHeartbeatCache(chatId);
  clearChatBotImageCache(chatId);
}

/**
 * 测试隔离用的聚合清理：依次调用下面十个领域模块各自的 reset。不覆盖 gemini、openai、
 * imageDescription、mediaInputSupport、mediaTasks、persona、stickers、ttsUsage、
 * voiceSynthesis、weather 与 worker 这些模块，用到它们的测试自行复位。
 *
 * 生产没有调用方：AI Worker 重建就是换一个 isolate，线程上下文销毁即清空全部缓存；
 * 运行期的按群失效走上面的 invalidateChatRuntimeCache。
 */
export function resetAiChatWorkerCache(): void {
  resetAiChatHeartbeatCache();
  resetAiChatBotImageCache();
  resetAiChatCompactionCache();
  resetGeminiContextCache();
  resetAiChatIdentityCache();
  resetImageGenerationCache();
  resetAiChatMemoryCache();
  resetAiChatMoodCache();
  resetAiProviderSchedulerCache();
  resetAiChatReplyCache();
}
