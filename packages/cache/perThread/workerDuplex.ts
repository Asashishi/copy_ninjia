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

/**
 * 当前 isolate 尚未收到主线程回执的请求。
 * 清理：收到回执、请求被 signal 取消、resetWorkerDuplex（Worker stop）时删除。
 * 容量：受各 Worker 自身业务并发上限与 Telegram 主线程总闸共同约束，不另设
 * 淘汰——丢掉一个 waiter 会让调用方永远等下去。Worker 重建：新 isolate 从空表
 * 开始，旧请求由主线程代际 signal 取消。
 */
export const workerDuplexWaiters: Map<number, WorkerDuplexWaiter> = new Map();

/** 当前 isolate 的单调请求编号；不回退，避免迟到回执命中新请求。 */
export const workerDuplexRequestCounter: { current: number } = { current: 0 };

/**
 * 当前 Worker 业务生命周期的默认能力请求取消信号。
 *
 * 由需要协作式排空的 Worker 在启动时注入；每个请求创建时捕获当时的信号，
 * drain 可短暂置空以派发只属于收尾阶段的能力请求，随后恢复已经 abort 的业务
 * 信号，保证迟到业务仍 fail-fast。AI Worker 未配置时保持 null。Worker stop
 * 由 resetWorkerDuplex 清空，重建后的新 isolate 从 null 开始。
 */
export const workerDuplexRequestSignal: { current: AbortSignal | null } = { current: null };

/** 当前 isolate 注入的唯一 postMessage 出口；Worker 停止时清空。 */
export const workerDuplexPoster: {
  current: ((
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void) | null;
} = { current: null };
