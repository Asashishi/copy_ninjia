import type { AiMemorySnapshot } from "../types";

/** AI 闲聊主线程侧代理（src/aiChat.ts）的内存状态。 */

/** 各群最新的 AI 记忆快照镜像，见 aiChat.ts 模块头注「AI 记忆持久化」。 */
export const latestAiMemories: Map<number, AiMemorySnapshot> = new Map();

/** flushAiMemory 的回执路由：flushId -> resolve（握手样式同 cache/diskIO.ts 的 pendingFlushes）。 */
export const pendingMemoryFlushes: Map<number, () => void> = new Map();
