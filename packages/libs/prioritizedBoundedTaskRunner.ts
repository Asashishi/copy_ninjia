import { LinkedQueue } from "./linkedQueue";

/** 有界执行器的两档优先级；交互请求优先，后台维护仍按受控比例获得执行机会。 */
export type TaskPriority = "interactive" | "background";

/**
 * 带交互优先级的进程内有界异步执行器。等待上限按两档队列合计计算；后台另有
 * 更小的占用上限，避免启动对账或批量摘要先把真人请求的全部等待位占满。
 */
export interface PrioritizedBoundedTaskRunner {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly backgroundPendingCount: number;
  run<T>(priority: TaskPriority, task: () => Promise<T>): Promise<T | undefined>;
}

/** 创建优先级执行器的容量与公平参数。 */
export interface PrioritizedBoundedTaskRunnerOptions {
  readonly maxConcurrent: number;
  readonly maxPending: number;
  readonly maxBackgroundPending: number;
  readonly interactiveBurst: number;
}

/** 创建带交互优先级、公平突发和总等待硬顶的异步执行器。 */
export function createPrioritizedBoundedTaskRunner({
  maxConcurrent,
  maxPending,
  maxBackgroundPending,
  interactiveBurst,
}: PrioritizedBoundedTaskRunnerOptions): PrioritizedBoundedTaskRunner {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new RangeError("maxPending must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(maxBackgroundPending) ||
    maxBackgroundPending < 0 ||
    maxBackgroundPending > maxPending
  ) {
    throw new RangeError("maxBackgroundPending must be a safe integer within maxPending");
  }
  if (!Number.isSafeInteger(interactiveBurst) || interactiveBurst <= 0) {
    throw new RangeError("interactiveBurst must be a positive safe integer");
  }

  let activeCount: number = 0;
  let interactiveStarts: number = 0;
  const interactivePending: LinkedQueue<() => void> = new LinkedQueue<() => void>();
  const backgroundPending: LinkedQueue<() => void> = new LinkedQueue<() => void>();

  function takePending(): (() => void) | undefined {
    if (
      backgroundPending.size > 0 &&
      (interactivePending.size === 0 || interactiveStarts >= interactiveBurst)
    ) {
      interactiveStarts = 0;
      return backgroundPending.shift();
    }
    const interactive: (() => void) | undefined = interactivePending.shift();
    if (interactive !== undefined) {
      interactiveStarts += 1;
      return interactive;
    }
    interactiveStarts = 0;
    return backgroundPending.shift();
  }

  function start<T>(task: () => Promise<T>): Promise<T> {
    activeCount += 1;
    return Promise.resolve()
      .then(task)
      .finally((): void => {
        activeCount -= 1;
        takePending()?.();
      });
  }

  return {
    get activeCount(): number {
      return activeCount;
    },
    get pendingCount(): number {
      return interactivePending.size + backgroundPending.size;
    },
    get backgroundPendingCount(): number {
      return backgroundPending.size;
    },
    run<T>(priority: TaskPriority, task: () => Promise<T>): Promise<T | undefined> {
      if (activeCount < maxConcurrent) return start(task);
      const pendingCount: number = interactivePending.size + backgroundPending.size;
      if (
        pendingCount >= maxPending ||
        (priority === "background" && backgroundPending.size >= maxBackgroundPending)
      ) return Promise.resolve(undefined);
      return new Promise<T>((
        resolve: (value: T | PromiseLike<T>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        const resume: () => void = (): void => {
          void start(task).then(resolve, reject);
        };
        if (priority === "interactive") interactivePending.push(resume);
        else backgroundPending.push(resume);
      });
    },
  };
}
