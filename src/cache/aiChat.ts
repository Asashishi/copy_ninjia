import type { AiInitMessage } from "../types";

/** AI 闲聊主线程侧代理（src/aiChat.ts）的内存状态。 */

/** 最近一次注入 AI Worker 的 init 消息，供 Worker 崩溃重启后重放（新 Worker
 *  不知道机器人自己的账号身份），见 aiChat.ts 的 initAiChat/onRespawn。 */
export const lastInitState: { current: AiInitMessage | null } = { current: null };

/** 各群最新的 AI 记忆快照镜像（值是序列化 JSON 文本，与消息协议同形态，
 *  见 types/aiChat.ts 的 AiMemoryEvent.snapshot），见 aiChat.ts 模块头注
 *  「AI 记忆持久化」。 */
export const latestAiMemories: Map<number, string> = new Map();
/** 已请求彻底清除记忆的群；用于拒绝失效 Worker 迟到的旧快照。 */
export const purgedAiMemoryChats: Set<number> = new Set();
/** 各白名单贴纸包最新的目录快照镜像（同为序列化 JSON 文本），机制与
 *  latestAiMemories 完全一致（双向崩溃重放的唯一来源），见 aiChat.ts 模块头注。 */
export const latestStickerCatalogs: Map<string, string> = new Map();

/** flushAiMemory 的回执路由：flushId -> resolve（握手样式同 cache/diskIO.ts 的 pendingFlushes）。 */
export const pendingMemoryFlushes: Map<number, () => void> = new Map();
