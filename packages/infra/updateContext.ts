import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 主线程 update handler 的异步上下文。owner 是 app/updateRunner.ts：每个
 * Telegram update 进入 middleware 前填入独立 signal，handler 完成后由
 * AsyncLocalStorage 自动退出；Worker isolate 与后台维护任务不会继承它。
 */
const updateAbortSignalStorage: AsyncLocalStorage<AbortSignal> =
  new AsyncLocalStorage<AbortSignal>();

/** 在指定 update 的取消上下文中执行完整 middleware 链。 */
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
