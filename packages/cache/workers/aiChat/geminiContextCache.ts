/** owner: workers/aiChat。Gemini 回复共用显式缓存（cachedContent，text scope）的本地登记。 */

import type { GeminiContextCacheRegistry } from "../../../types/geminiContextCache";

/**
 * text scope 的登记表（结构见 types/geminiContextCache.ts，读写见
 * infra/geminiContextCache.ts）。null 表示本线程尚未取用或已被复位。
 *
 * 填充：回复首轮第一次取用时按当下 text 客户端新建，随即触发启动扫描，按 displayName
 * 接管服务端既有条目；后台创建成功时写槽，命中刷新 lastUsedAt，续期成功改写 expireAt。
 * 清理：同槽内容变化时换条目并删除旧的服务端条目；新建条目后删除接管以来从未用过的
 * 条目；超过 GEMINI_TEXT_CACHE_MAX_SLOTS 槽时删除最久未用的槽；首轮请求报缓存不可用（此后
 * 冷却 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 再重建）或续期报 404 时摘掉本地登记。agent.text
 * 热重载有变化时置 null（aiChat/provider.ts），下一次取用按新客户端新建并重新扫描，旧表上的
 * 在途请求只写旧表。服务端条目另按 TTL 自行过期。
 * Worker 崩溃重建：新 isolate 从 null 起步，第一次回复时重新扫描接管。
 * 容量：一张表；槽至多 GEMINI_TEXT_CACHE_MAX_SLOTS 个，失败与被拒记录不超过本表出现过的
 * 槽键数（该槽创建成功或被淘汰时删除），进行中的创建不超过同时在用的槽数。
 */
export const textGeminiContextCache: { current: GeminiContextCacheRegistry | null } = { current: null };

/** 测试隔离时丢弃本地登记（见 cache/workers/aiChat/index.ts）；不触碰服务端条目。 */
export function resetGeminiContextCache(): void {
  textGeminiContextCache.current = null;
}
