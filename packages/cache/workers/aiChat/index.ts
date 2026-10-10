/** owner: workers/aiChat。本文件不持有状态，只聚合本线程各领域缓存模块的失效与清理边界。 */

import { repliedBotImageBackfills, resetAiChatBotImageCache } from "./botImages";
import { resetAiChatCompactionCache } from "./compaction";
import { geminiReplyLastRequestAt, resetGeminiContextCache } from "./geminiContextCache";
import { clearChatHeartbeatCache, resetAiChatHeartbeatCache } from "./heartbeat";
import { resetAiChatIdentityCache } from "./identity";
import { resetImageGenerationCache } from "./imageGeneration";
import { resetAiChatMemoryCache } from "./memory";
import { resetAiChatMoodCache } from "./mood";
import { resetAiProviderSchedulerCache } from "./providerScheduler";
import { invalidateChatReplyCache, resetAiChatReplyCache } from "./replies";

/** AI 禁用或记忆淘汰的统一运行时失效边界。压缩链不提前删除：代际使旧
 * 结果失效，链自然排空。 */
export function invalidateChatRuntimeCache(chatId: number): void {
  invalidateChatReplyCache(chatId);
  clearChatHeartbeatCache(chatId);
  // 在途识别仍按代际自行作废；在途 Gemini 回复请求成功时仍会写回触发时刻（见 geminiContextCache.ts）。
  repliedBotImageBackfills.delete(chatId);
  geminiReplyLastRequestAt.delete(chatId);
}

/**
 * 测试隔离用的聚合清理：依次调用下面各领域模块各自的 reset。不覆盖 gemini、openai、
 * imageDescription、mediaInputSupport、mediaTasks、stickers、ttsUsage、
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
