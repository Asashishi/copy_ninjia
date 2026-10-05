/**
 * 主线程向 Worker 发起、按 requestId 等回执的请求表：心情查询/重抽、群失效、语音合成与摘要组稿
 * 共用。等待者先登记后投递（同步回执也不会丢，同 libs/flushBarrier.ts 的顺序约定），结算只有
 * 回执、超时、调用方取消、投递被拒与 Worker 崩溃重建 / 放弃 / 终止五条路，一律经 resolve 交回
 * 调用方给定的结果，不 reject。等待表实例由调用方的 cache 模块持有。
 */

import type { WorkerRequestTable, WorkerRequestWaiter } from "../types/workerRequest";

/** 摘除并收尾一个等待者；已结算或未知的 requestId 返回 undefined。 */
function takeWorkerRequest<T>(table: WorkerRequestTable<T>, requestId: number): WorkerRequestWaiter<T> | undefined {
  const waiter: WorkerRequestWaiter<T> | undefined = table.waiters.get(requestId);
  if (waiter === undefined) return undefined;
  table.waiters.delete(requestId);
  clearTimeout(waiter.timer);
  if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  return waiter;
}

/** 调用方取消源与取消时交回的结果。 */
export interface WorkerRequestAbort<T> {
  /** 调用前已中止由调用方先行判定，这里只监听之后的中止。 */
  readonly signal: AbortSignal | undefined;
  readonly result: T;
}

/** beginWorkerRequest 的入参。 */
export interface BeginWorkerRequestOptions<T> {
  readonly table: WorkerRequestTable<T>;
  readonly timeoutMs: number;
  /** 投递带 requestId 的请求；返回 false 表示同步拒绝，按 rejected 结算。 */
  readonly post: (requestId: number) => boolean;
  /** 超时或取消后撤回 Worker 侧的工作；不需要撤回时省略。 */
  readonly cancel?: (requestId: number) => void;
  /** 调用方取消；请求不可取消时省略。 */
  readonly abort?: WorkerRequestAbort<T>;
  readonly timedOut: T;
  readonly rejected: T;
}

/** 登记一个等待者并投递请求，返回在五条结算路之一兑现的 Promise。 */
export function beginWorkerRequest<T>({
  table,
  timeoutMs,
  post,
  cancel,
  abort,
  timedOut,
  rejected,
}: BeginWorkerRequestOptions<T>): Promise<T> {
  return new Promise((resolve: (result: T) => void): void => {
    const requestId: number = ++table.counter.current;
    const withdraw = (result: T): void => {
      const waiter: WorkerRequestWaiter<T> | undefined = takeWorkerRequest(table, requestId);
      if (waiter === undefined) return;
      cancel?.(requestId);
      waiter.resolve(result);
    };
    const signal: AbortSignal | undefined = abort?.signal;
    const onAbort: (() => void) | undefined = abort === undefined || signal === undefined
      ? undefined
      : (): void => withdraw(abort.result);
    table.waiters.set(requestId, {
      resolve,
      timer: setTimeout((): void => withdraw(timedOut), timeoutMs),
      signal,
      onAbort,
    });
    if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
    if (!post(requestId)) takeWorkerRequest(table, requestId)?.resolve(rejected);
  });
}

/** 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。 */
export function settleWorkerRequest<T>(table: WorkerRequestTable<T>, requestId: number, result: T): void {
  takeWorkerRequest(table, requestId)?.resolve(result);
}

/** Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按同一结果结算。 */
export function failAllWorkerRequests<T>(table: WorkerRequestTable<T>, result: T): void {
  for (const requestId of [...table.waiters.keys()]) {
    takeWorkerRequest(table, requestId)?.resolve(result);
  }
}
