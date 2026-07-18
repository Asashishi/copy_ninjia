/**
 * 进程内的有界异步任务执行器：最多同时执行 maxConcurrent 个任务，另保留
 * maxPending 个尚未启动的轻量闭包。两层都满时立即返回 undefined，调用方
 * 自行降级，避免流量洪峰把下载缓冲/API 请求或等待 Promise 无界堆进内存。
 */
export interface BoundedTaskRunner {
  readonly activeCount: number;
  readonly pendingCount: number;
  run<T>(task: () => Promise<T>): Promise<T | undefined>;
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

  const start = <T>(task: () => Promise<T>): Promise<T> => {
    activeCount++;
    return Promise.resolve()
      .then(task)
      .finally(() => {
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
    run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (activeCount < maxConcurrent) return start(task);
      if (pending.length >= maxPending) return Promise.resolve(undefined);
      return new Promise<T>((resolve, reject) => {
        pending.push(() => {
          void start(task).then(resolve, reject);
        });
      });
    },
  };
}
