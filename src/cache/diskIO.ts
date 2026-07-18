import type { LoadedReply, LuckReceiptSecret } from "../types";

/** 磁盘 IO 宿主（src/infra/diskIO.ts）的内存状态：主线程侧的 flush/load 回执路由。 */

/** flushDiskIO 的回执路由：flushId -> resolve。 */
export const pendingFlushes: Map<number, () => void> = new Map();

/**
 * loadPersistedData 当前挂起的那次调用的回调。Worker 崩溃重建后会自动
 * 重跑一遍 load（见 infra/diskIO.ts 的 onerror），这次回执没有人专门等待
 * ——此时这里是 null，回执被静默丢弃即可（Worker 侧缓存的热身在它自己
 * 内部就已经完成，不需要主线程再做什么）。
 */
export const pendingLoad: { resolve: ((reply: LoadedReply) => void) | null } = { resolve: null };

/** ensureLuckReceiptSecret 的逐请求等待表。 */
export const pendingLuckSecrets: Map<number, {
  resolve: (secret: LuckReceiptSecret) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();
