import type { StickerCatalogEntry } from "../types";

/** 白名单贴纸包画面描述目录（src/ai/stickerCatalog.ts）的内存状态。 */

/** pack short name -> (贴纸自身 file_unique_id -> 目录条目)。 */
export const catalogs: Map<string, Map<string, StickerCatalogEntry>> = new Map();

/** 自上次上报后有更新、待上报给主线程落盘的包。 */
export const dirtyPacks: Set<string> = new Set();

/** 已知生成失败的贴纸（file_unique_id），本进程内不重试（重启后再试）。 */
export const failedEntries: Set<string> = new Set();

/** 正在后台生成中的包，防止 init 消息重放（Worker 崩溃重启）时重复发起。 */
export const generatingPacks: Set<string> = new Set();
