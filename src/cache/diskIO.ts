import type { LoadedReply } from "../types/diskIO";
import type { LuckReceiptSecret } from "../types/diskIO/storage";
import type { FlushResult } from "../consts/lifecycle";

/** 磁盘 IO 宿主（src/infra/diskIO.ts）的内存状态：主线程侧的 flush/load 回执路由。 */

/** flushDiskIO 的回执路由：flushId -> resolve。 */
export const pendingFlushes: Map<number, (result: FlushResult) => void> = new Map();

/**
 * loadPersistedData 当前挂起的启动恢复回调。运行时重建另由 infra/diskIO.ts
 * 的显式 recovery Worker 状态接管，成功前始终不可写。
 */
export const pendingLoad: { resolve: ((reply: LoadedReply) => void) | null } = { resolve: null };

/** ensureLuckReceiptSecret 的逐请求等待表。 */
export const pendingLuckSecrets: Map<number, {
  resolve: (secret: LuckReceiptSecret) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();
