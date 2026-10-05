/** 主线程向 Worker 发起、按 requestId 等回执的请求（libs/workerRequestTable.ts）。 */

/** 一次请求的等待者；结算时清掉 timer 并摘下调用方 signal 的监听。 */
export interface WorkerRequestWaiter<T> {
  readonly resolve: (result: T) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** 调用方取消信号及其监听；没给 signal 时两者均为 undefined。 */
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/** 一类请求的等待表与本进程内单调递增的 requestId 计数器。 */
export interface WorkerRequestTable<T> {
  readonly waiters: Map<number, WorkerRequestWaiter<T>>;
  readonly counter: { current: number };
}

/** 失败要以 Error 交给调用方的请求，在等待表里统一用这个结局联合结算。 */
export type WorkerRequestOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };
