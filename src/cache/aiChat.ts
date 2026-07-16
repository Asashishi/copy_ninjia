import type { AiMemorySnapshot, StickerCatalogSnapshot } from "../types";

/** AI 闲聊主线程侧代理（src/aiChat.ts）的内存状态。 */

/** 各群最新的 AI 记忆快照镜像，见 aiChat.ts 模块头注「AI 记忆持久化」。 */
export const latestAiMemories: Map<number, AiMemorySnapshot> = new Map();
/** 各白名单贴纸包最新的目录快照镜像，机制与 latestAiMemories 完全一致
 *  （双向崩溃重放的唯一来源），见 aiChat.ts 模块头注。 */
export const latestStickerCatalogs: Map<string, StickerCatalogSnapshot> = new Map();

/** flushAiMemory 的回执路由：flushId -> resolve（握手样式同 cache/diskIO.ts 的 pendingFlushes）。 */
export const pendingMemoryFlushes: Map<number, () => void> = new Map();
