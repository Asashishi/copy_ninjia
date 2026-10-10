/** owner: workers/aiChat。Gemini 回复共用显式缓存（cachedContent，text scope）的本地登记，以及各群上一次回复请求的触发时刻。 */

import { GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS } from "../../../consts/aiChat/gemini";
import type { GeminiContextCacheRegistry } from "../../../types/geminiContextCache";

/**
 * text scope 的登记表（结构见 types/geminiContextCache.ts，读写见
 * infra/geminiContextCache.ts）。null 表示本线程尚未取用或已被复位。
 *
 * 填充：走显式缓存的回复请求第一次取用时按当下 text 客户端新建，随即触发启动扫描，按 displayName
 * 接管服务端既有条目；后台创建成功时写槽，命中刷新 lastUsedAt，续期成功改写 expireAt。
 * 清理：同槽内容变化时换条目并删除旧的服务端条目；新建条目后删除接管以来从未用过的
 * 条目；超过 GEMINI_TEXT_CACHE_MAX_SLOTS 槽时删除最久未用的槽；显式缓存请求报缓存不可用（此后
 * 冷却 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 再重建）或续期报 404 时摘掉本地登记。agent.text
 * 热重载有变化时置 null（aiChat/provider.ts），下一次取用按新客户端新建并重新扫描，旧表上的
 * 在途请求只写旧表。服务端条目另按 TTL 自行过期。
 * Worker 崩溃重建：新 isolate 从 null 起步，第一次走显式缓存的回复重新扫描接管。
 * 容量：一张表；槽至多 GEMINI_TEXT_CACHE_MAX_SLOTS 个，失败与被拒记录不超过本表出现过的
 * 槽键数（该槽创建成功或被淘汰时删除），进行中的创建不超过同时在用的槽数。
 */
export const textGeminiContextCache: { current: GeminiContextCacheRegistry | null } = { current: null };

/**
 * 各群的触发时刻：chatId -> 本群上一次成功的 Gemini 回复 generateContent 的发出时刻（本线程
 * performance.now() 毫秒）。没有条目表示本群在本线程还没有成功的回复请求，或条目已被清理。回复
 * 会话用它决定本群第 1 次请求走显式缓存还是完整结构（见 aiChat/gemini/replySession.ts，阈值
 * GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS）；各群互不影响。
 *
 * 填充：本群回复请求成功后写入它的发出时刻，失败的请求不写；并行请求可能乱序完成，不晚于本群
 * 已记录值的不覆盖。显式缓存被拒后的完整结构补发按补发时刻计。
 * 清理：经 invalidateChatRuntimeCache（cache/workers/aiChat/index.ts）随本群其它运行时缓存一起删除，
 * 此后本群在途请求成功时仍会写回；AI Worker 维护节拍经 sweepGeminiReplyRequestTimes 删除已超过
 * GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 的条目（与没有条目等价）；测试隔离时经 resetGeminiContextCache 清空。
 * text 热重载只丢弃上面的登记表，不改这些时刻。
 * Worker 崩溃重建：新 isolate 从空表起步，计时起点随之更换；各群下一次回复的第 1 次请求走显式缓存。
 * 容量：最近一个维护间隔加 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 内成功发过 Gemini 回复请求的群数。
 */
export const geminiReplyLastRequestAt: Map<number, number> = new Map();

/**
 * 删除距 now（本线程 performance.now() 毫秒）已超过 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 的触发时刻；回复会话对这类
 * 条目与没有条目同样处理（走显式缓存）。由 AI Worker 维护节拍调用。
 */
export function sweepGeminiReplyRequestTimes(now: number): void {
  for (const [chatId, at] of geminiReplyLastRequestAt) {
    if (now - at > GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS) geminiReplyLastRequestAt.delete(chatId);
  }
}

/** 测试隔离时丢弃本地登记与各群上一次回复请求的触发时刻；不触碰服务端条目。 */
export function resetGeminiContextCache(): void {
  textGeminiContextCache.current = null;
  geminiReplyLastRequestAt.clear();
}
