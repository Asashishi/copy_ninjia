/** Owner: Anti-Raid Worker。ad_detect 显式缓存（Gemini cachedContent）的本地登记与内容指纹。 */

import type { GeminiContextCacheContent, GeminiContextCacheRegistry } from "../../../types/geminiContextCache";

/**
 * ad_detect scope 的登记表（结构见 types/geminiContextCache.ts，读写见
 * infra/geminiContextCache.ts，scope 在 antiRaid/ai/google.ts）。null 表示本线程尚未取用或
 * 已被复位。
 *
 * 填充：provider=google 时第一次判定按当下 ad_detect 客户端新建，随即触发启动扫描，按
 * displayName 接管服务端既有条目；后台创建成功时写槽，命中刷新 lastUsedAt，续期成功改写
 * expireAt。
 * 清理：同槽内容变化时换条目并删除旧的服务端条目；新建条目后删除接管以来从未用过的
 * 条目；超过 AD_DETECT_GEMINI_CACHE_MAX_SLOTS 槽时删除最久未用的槽；判定请求报缓存不可用
 * （此后冷却 GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS 再重建）或续期报 404 时摘掉本地登记。主线程
 * 投递的 agent.ad_detect 有变化时由 workers/antiRaid/adDetect/config.ts 置 null，下一次判定按
 * 新客户端新建并重新扫描，旧表上的在途请求只写旧表。服务端条目另按 TTL 自行过期。
 * Worker 崩溃重建：新 isolate 从 null 起步，第一次判定时重新扫描接管。
 * 容量：一张表；槽至多 AD_DETECT_GEMINI_CACHE_MAX_SLOTS 个，失败与被拒记录不超过本表出现过的
 * 槽键数（该槽创建成功或被淘汰时删除），进行中的创建不超过同时在用的槽数。
 */
export const adDetectGeminiContextCache: { current: GeminiContextCacheRegistry | null } = { current: null };

/**
 * 当前「判定规则 + 部署示例」段及其两段指纹（infra/geminiContextCache.ts 的
 * geminiContextCacheContent），判定路径每次只核对模型与系统指令的引用，不重算指纹。
 *
 * 填充：provider=google 时第一次判定时写入；模型或系统指令对不上（示例快照替换、换模型）时
 * 重算并整体替换。清理：只随替换释放旧值，不单独清空。
 * Worker 崩溃重建：从 null 起步，第一次判定时重算。容量固定为一份。
 */
export const adDetectGeminiCacheContent: { current: GeminiContextCacheContent | null } = { current: null };
