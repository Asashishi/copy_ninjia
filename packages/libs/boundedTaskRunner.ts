/**
 * 进程内的有界异步任务执行器：最多同时执行 maxConcurrent 个任务，另保留
 * maxPending 个尚未启动的轻量闭包。两层都满时立即返回 undefined，调用方
 * 自行降级，避免流量洪峰把下载缓冲/API 请求或等待 Promise 无界堆进内存。
 */
export interface BoundedTaskRunner {
  readonly activeCount: number;
  readonly pendingCount: number;
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined>;
}

export function createBoundedTaskRunner(maxConcurrent: number, maxPending: number): BoundedTaskRunner {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new RangeError("maxPending must be a non-negative safe integer");
  }

  let activeCount: number = 0;
  const pending: (() => void)[] = [];

  const start = <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> => {
    activeCount++;
    return Promise.resolve()
      .then((): Promise<T> | undefined => {
        return signal?.aborted === true ? undefined : task();
      })
      .finally((): void => {
        activeCount--;
        pending.shift()?.();
      });
  };

  return {
    get activeCount(): number {
      return activeCount;
    },
    get pendingCount(): number {
      return pending.length;
    },
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
      if (signal?.aborted === true) return Promise.resolve(undefined);
      if (activeCount < maxConcurrent) return start(task, signal);
      if (pending.length >= maxPending) return Promise.resolve(undefined);
      return new Promise<T | undefined>((
        resolve: (value: T | undefined | PromiseLike<T | undefined>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        let queued: boolean = true;

        function resume(): void {
          if (!queued) return;
          queued = false;
          signal?.removeEventListener("abort", onAbort);
          void start(task, signal).then(resolve, reject);
        }

        function onAbort(): void {
          if (!queued) return;
          const index: number = pending.indexOf(resume);
          if (index < 0) return;
          pending.splice(index, 1);
          queued = false;
          signal?.removeEventListener("abort", onAbort);
          resolve(undefined);
        }

        // 入口处已对已 abort 的 signal 提前返回，且到这里没有跨过任何 await，
        // 因此注册即生效，不需要在注册后再补一次 aborted 复查。
        pending.push(resume);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
