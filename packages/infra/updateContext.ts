import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 主线程异步取消上下文。app/updateRunner.ts 为每条 update 填入独立 signal；
 * wed/runtime.ts 在交互出队时恢复接纳时的信号并合入自己的停机边界。
 * run 返回后退出调用方上下文，异步子任务继续持有各自的 signal；Worker isolate 不共享本存储。
 */
const updateAbortSignalStorage: AsyncLocalStorage<AbortSignal> =
  new AsyncLocalStorage<AbortSignal>();

/** 在指定取消上下文中执行 middleware 或已经接纳的异步交互。 */
export function runWithUpdateAbortSignal<T>(
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  return updateAbortSignalStorage.run(signal, run);
}

/** 当前异步调用链所属 update 的取消信号；非 update owner 返回 undefined。 */
export function currentUpdateAbortSignal(): AbortSignal | undefined {
  return updateAbortSignalStorage.getStore();
}

/** 将调用方自己的取消边界与当前 update 生命周期合并。 */
export function combineWithUpdateAbortSignal(
  signal?: AbortSignal
): AbortSignal | undefined {
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  if (signal === undefined) return updateSignal;
  if (updateSignal === undefined || updateSignal === signal) return signal;
  return AbortSignal.any([signal, updateSignal]);
}

/** update 已被停机流程取消时向上解开 handler，禁止按普通业务失败继续执行。 */
export function throwIfUpdateAborted(
  signal: AbortSignal | undefined = currentUpdateAbortSignal()
): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Telegram update was aborted during shutdown.", "AbortError");
}
