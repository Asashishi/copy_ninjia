import type { StickerCatalogEntry } from "../../types/stickers/catalog";

/** 白名单贴纸包画面描述目录（packages/ai/stickers/catalog.ts）的权威内存状态。
 * 仅 ai/stickers/catalog.ts 直接读写；其它领域不得绕过其公开生命周期 API。
 * 每包容量由 Telegram 当前贴纸集合自然约束，不另设 TTL；目录快照持久化到
 * memory/stickers/，Worker 重建时先 hydrate，再与线上集合对账。dirty、失败
 * 与生成中集合只属于本次 Worker 生命周期，重启后清空重建。 */

/** pack short name -> (贴纸自身 file_unique_id -> 目录条目)。 */
export const catalogs: Map<string, Map<string, StickerCatalogEntry>> = new Map();

/** pack short name -> AI 生成的整包简介（≤200 字），供两层贴纸工具的第一层
 *  挑包；生成/重生成时机见 packages/ai/stickers/catalog.ts 的 generatePackCatalog。 */
export const packSummaries: Map<string, string> = new Map();

/** 自上次上报后有更新、待上报给主线程落盘的包。 */
export const dirtyPacks: Set<string> = new Set();

/** pack short name -> 已知生成失败的贴纸（file_unique_id）：退避重试用完仍
 *  失败才进来（见 ai/stickers/catalog.ts 的 callWithRetry），本进程内不再试
 *  （重启后再试）。按包分桶，让对账剪枝能把已被移出包的贴纸的失败记录
 *  一并清掉，不必滞留到 Worker 重启。 */
export const failedEntries: Map<string, Set<string>> = new Map();

/** 正在后台生成中的包，防止 init 消息重放（Worker 崩溃重启）时重复发起。 */
export const generatingPacks: Set<string> = new Set();

/** 上一次「目录仍不完整」的周期重试时刻（见 ai/stickers/catalog.ts 的
 *  retryIncompleteStickerCatalogs）。0 表示本进程还没试过，第一次维护节拍
 *  就会补一次；只在主线程之外的 AI 闲聊线程里被读写。 */
export const stickerCatalogRetryState: { lastAttemptAt: number } = { lastAttemptAt: 0 };
