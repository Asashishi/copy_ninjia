/** 共享任务的结果与可摘除等待者；每份源 Promise 只登记一次结算回调。 */
export interface SharedResult<T> {
  readonly promise: Promise<T>;
  readonly waiterCount: number;
  readonly wait: (signal?: AbortSignal) => Promise<T>;
}

export interface CreateSharedResultOptions<T> {
  readonly cancelled: T;
  readonly rejected: T;
  /** 最后一个可取消等待者离开且没有无信号等待者时调用；正常结算不调用。 */
  readonly onUnused?: () => void;
}

/**
 * 为共享任务建立可取消订阅。取消同步摘除等待者和 abort 监听，不向源 Promise
 * 追加每个消费者的回调；源任务是否中止由 onUnused 的领域 owner 决定。
 */
export function createSharedResult<T>(
  source: Promise<T>,
  { cancelled, rejected, onUnused }: CreateSharedResultOptions<T>
): SharedResult<T> {
  const waiters: Set<(value: T) => void> = new Set<(value: T) => void>();
  let settled: boolean = false;
  let pinned: boolean = false;

  function settle(value: T): T {
    settled = true;
    for (const finish of waiters) finish(value);
    return value;
  }

  const promise: Promise<T> = source.then(settle, (): T => settle(rejected));
  return {
    promise,
    get waiterCount(): number {
      return waiters.size;
    },
    wait(signal?: AbortSignal): Promise<T> {
      if (signal === undefined) {
        pinned = true;
        return promise;
      }
      if (signal.aborted) return Promise.resolve(cancelled);
      if (settled) return promise;
      const activeSignal: AbortSignal = signal;
      return new Promise<T>((resolve: (value: T) => void): void => {
        function finish(value: T): void {
          waiters.delete(finish);
          activeSignal.removeEventListener("abort", onAbort);
          resolve(value);
        }

        function onAbort(): void {
          finish(cancelled);
          if (!settled && !pinned && waiters.size === 0) onUnused?.();
        }

        waiters.add(finish);
        activeSignal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
