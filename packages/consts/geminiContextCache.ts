/**
 * Gemini 显式缓存（cachedContent）共用核心的常量，与能力无关；text 与 ad_detect 两个
 * scope 共用同一组存活、续期与冷却口径。各 scope 自己的 displayName 前缀、槽数上限与
 * 错误标签在 consts/aiChat/gemini.ts 与 consts/antiRaid/adDetect.ts。
 */

/**
 * 服务端条目的存活时长（秒），即 Gemini 缓存 API 的默认 TTL。创建与续期都显式写入
 * 这个值；到期由 Google 自动删除。所属模块：infra/geminiContextCache.ts。
 */
export const GEMINI_CONTEXT_CACHE_TTL_SECONDS: number = 3_600;

/**
 * displayName 里两段指纹各自的形态：libs/prefixFingerprint.ts 产出的固定 43 字符
 * base64url。启动扫描据此认出本部署的条目；前缀加两段指纹不超过 displayName 的
 * 128 字符上限。所属模块：infra/geminiContextCache.ts。
 */
export const GEMINI_CONTEXT_CACHE_KEY_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

/**
 * 引用条目时要求的最少剩余存活时长；不足时本次走完整请求并重建。
 * 所属模块：infra/geminiContextCache.ts。
 */
export const GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS: number = 5 * 60_000;

/**
 * 命中时剩余存活时长低于这一档就在后台续期回 GEMINI_CONTEXT_CACHE_TTL_SECONDS。
 * 与 GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS 之和必须小于 TTL，否则新条目一出生就落进
 * 续期档。所属模块：infra/geminiContextCache.ts。
 */
export const GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS: number = 30 * 60_000;

/**
 * 某槽创建因瞬时错误失败、或某条目续期失败后，这段时间内不再重发同一种请求，期间
 * 未命中的请求走完整请求、命中的照常引用。所属模块：infra/geminiContextCache.ts。
 */
export const GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS: number = 10 * 60_000;

/** 启动扫描 caches.list 的单页条数。所属模块：infra/geminiContextCache.ts。 */
export const GEMINI_CONTEXT_CACHE_LIST_PAGE_SIZE: number = 100;
