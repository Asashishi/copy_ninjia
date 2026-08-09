/**
 * Worker -> 主线程双工请求的 per-thread 运行态。
 *
 * owner：当前业务 Worker isolate。主线程不初始化本表；AI/Anti-Raid Worker
 * 各自得到独立实例。请求发出时填充，收到回执、取消、Worker 退出时清理；容量
 * 受各 Worker 自身业务并发上限与 Telegram 主线程总闸共同约束。Worker 重建时
 * 新 isolate 从空表开始，旧请求由主线程代际 signal 取消。
 */

import type { WorkerDuplexOutbound } from "../../types/workerDuplex";

/** 单个跨线程请求的等待者。 */
export interface WorkerDuplexWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

/** 当前 isolate 尚未收到主线程回执的请求。 */
export const workerDuplexWaiters: Map<number, WorkerDuplexWaiter> = new Map();

/** 当前 isolate 的单调请求编号；不回退，避免迟到回执命中新请求。 */
export const workerDuplexRequestCounter: { current: number } = { current: 0 };

/** 当前 isolate 注入的唯一 postMessage 出口；Worker 停止时清空。 */
export const workerDuplexPoster: {
  current: ((
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void) | null;
} = { current: null };
