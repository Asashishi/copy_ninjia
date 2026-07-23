import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { createFlushBarrier } from "../libs/flushBarrier";
import type { AiInitMessage } from "../types/aiChat/protocol";

/** AI 闲聊主线程侧代理（src/aiChat.ts）的内存状态。 */

/**
 * AI Worker 记忆回传 barrier。模块加载时创建，Worker 终止时统一结算等待者；
 * 进程重启后以空等待表重建，容量受并发 flush 数约束。
 */
export const aiMemoryFlushBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
});

/** 最近一次注入 AI Worker 的 init 消息，供 Worker 崩溃重启后重放（新 Worker
 *  不知道机器人自己的账号身份），见 aiChat.ts 的 initAiChat/onRespawn。 */
export const lastInitState: { current: AiInitMessage | null } = { current: null };

/** 各群最新的 AI 记忆快照镜像（值是序列化 JSON 文本，与消息协议同形态，
 *  见 types/aiChat.ts 的 AiMemoryEvent.snapshot），见 aiChat.ts 模块头注
 *  「AI 记忆持久化」。 */
export const latestAiMemories: Map<number, string> = new Map();
/** latestAiMemories 中每份快照对应的运行时 revision。启动恢复快照统一从 0 开始。 */
export const latestAiMemoryRevisions: Map<number, number> = new Map();
/** 本进程内各 chat 已分配的最高 revision；进程重启后旧消息不存在，可安全从 0 重建。 */
export const aiMemoryRevisionCounters: Map<number, number> = new Map();
/** 已投递但尚未收到 durable delete 回执的最新墓碑。 */
export const pendingAiMemoryDeletes: Map<number, number> = new Map();
/** 等待某群指定 AI 记忆删除 revision durable 的调用方。 */
export interface AiMemoryDeleteWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** 只有显式禁用/teardown 会等待；LRU 删除只保留 pending tombstone。 */
export const aiMemoryDeleteWaiters: Map<number, AiMemoryDeleteWaiter[]> = new Map();
/** 已请求彻底清除记忆的群；用于拒绝失效 Worker 迟到的旧快照。 */
export const purgedAiMemoryChats: Set<number> = new Set();
/** 等待 /switch_mood 重抽回执（moodSwitched 事件）的调用方。 */
export interface MoodSwitchWaiter {
  resolve: (moodName: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** 在途 switchMood 请求的等待表（requestId → waiter）：成功回执、超时或
 *  Worker 崩溃/终止时结算并删除（见 aiChat.ts 的 switchAiMood），容量受并发
 *  /switch_mood 命令数约束。 */
export const moodSwitchWaiters: Map<number, MoodSwitchWaiter> = new Map();
/** 本进程内已分配的最高 switchMood requestId；进程重启后旧请求不存在，可安全从 0 重建。 */
export const moodSwitchRequestCounter: { current: number } = { current: 0 };
/** Worker 是否仍可接收 invalidate 并回传 memoryDeleted；give-up 后显式关闭。 */
export const aiChatWorkerState: { available: boolean } = { available: false };
/** 各白名单贴纸包最新的目录快照镜像（同为序列化 JSON 文本），机制与
 *  latestAiMemories 完全一致（双向崩溃重放的唯一来源），见 aiChat.ts 模块头注。 */
export const latestStickerCatalogs: Map<string, string> = new Map();
