import { sleep } from "./sleep";

/** 一次可追溯批任务的执行上下文；attempt 从 1 开始并受退避数组硬顶约束。 */
export interface BoundedBatchExecution<T> {
  readonly item: T;
  readonly index: number;
  readonly attempt: number;
}

/** 一次失败是否值得重试的判定上下文。 */
export interface BoundedBatchFailure<T> extends BoundedBatchExecution<T> {
  readonly error: unknown;
}

/** 有界批处理的成功结果；保留原输入、下标和实际尝试次数供调用方追踪。 */
export interface BoundedBatchFulfilled<T, R> extends BoundedBatchExecution<T> {
  readonly status: "fulfilled";
  readonly value: R;
}

/** 有界批处理的失败结果；保留原输入、下标和最终错误供调用方逐项结算。 */
export interface BoundedBatchRejected<T> extends BoundedBatchExecution<T> {
  readonly status: "rejected";
  readonly reason: unknown;
}

/** 有界批处理逐项结果；数组顺序始终与输入顺序一致。 */
export type BoundedBatchResult<T, R> =
  | BoundedBatchFulfilled<T, R>
  | BoundedBatchRejected<T>;

/** 创建有界并发、有限退避重试和逐项结果所需的完整参数。 */
export interface RunBoundedSettledBatchOptions<T, R> {
  readonly items: readonly T[];
  readonly maxConcurrent: number;
  /** 每个值对应一次失败后的等待；长度为零表示领域不允许额外重试。 */
  readonly retryDelaysMs?: readonly number[];
  readonly execute: (execution: BoundedBatchExecution<T>) => Promise<R>;
  /** 缺省时所有仍有退避预算的失败都会重试；确定性失败可在这里提前拒绝。 */
  readonly shouldRetry?: (failure: BoundedBatchFailure<T>) => boolean;
  /** 每次真正进入退避前调用，用于记录输入身份、attempt 与等待时间。 */
  readonly onRetry?: (
    failure: BoundedBatchFailure<T> & Readonly<{ delayMs: number }>
  ) => void;
}

/**
 * 用固定 worker 数消费一批任务，并返回与输入同序的逐项 settlement。
 *
 * 动态输入不得直接 `map` 成整批 Promise：本函数只启动 maxConcurrent 个 worker；
 * 每项重试次数由 retryDelaysMs 长度硬顶，调用方可按领域错误决定是否重试并记录
 * 每次退避。worker 汇合必须等待全部结算，单项失败不会截断其它输入。
 */
export async function runBoundedSettledBatch<T, R>({
  items,
  maxConcurrent,
  retryDelaysMs = [],
  execute,
  shouldRetry,
  onRetry,
}: RunBoundedSettledBatchOptions<T, R>): Promise<BoundedBatchResult<T, R>[]> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  if (retryDelaysMs.some((delayMs: number): boolean =>
    !Number.isFinite(delayMs) || delayMs <= 0
  )) {
    throw new RangeError("retry delays must be positive finite numbers");
  }
  if (items.length === 0) return [];

  const results: (BoundedBatchResult<T, R> | undefined)[] =
    new Array<BoundedBatchResult<T, R> | undefined>(items.length);
  let nextIndex: number = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index: number = nextIndex++;
      const item: T = items[index]!;
      let attempt: number = 1;
      while (true) {
        try {
          const value: R = await execute({ item, index, attempt });
          results[index] = { item, index, attempt, status: "fulfilled", value };
          break;
        } catch (error: unknown) {
          const failure: BoundedBatchFailure<T> = { item, index, attempt, error };
          const delayMs: number | undefined = retryDelaysMs[attempt - 1];
          if (delayMs === undefined) {
            results[index] = { item, index, attempt, status: "rejected", reason: error };
            break;
          }
          let retryable: boolean;
          try {
            retryable = shouldRetry?.(failure) ?? true;
          } catch (retryError: unknown) {
            results[index] = {
              item,
              index,
              attempt,
              status: "rejected",
              reason: new AggregateError(
                [error, retryError],
                `Batch retry classifier rejected for item ${index}.`
              ),
            };
            break;
          }
          if (!retryable) {
            results[index] = { item, index, attempt, status: "rejected", reason: error };
            break;
          }
          try {
            onRetry?.({ ...failure, delayMs });
          } catch (traceError: unknown) {
            results[index] = {
              item,
              index,
              attempt,
              status: "rejected",
              reason: new AggregateError(
                [error, traceError],
                `Batch retry trace hook rejected for item ${index}.`
              ),
            };
            break;
          }
          await sleep(delayMs);
          attempt++;
        }
      }
    }
  }

  const workerCount: number = Math.min(maxConcurrent, items.length);
  const workers: Promise<void>[] = [];
  for (let index: number = 0; index < workerCount; index++) {
    workers.push(runWorker());
  }
  const workerSettlements: PromiseSettledResult<void>[] =
    await Promise.allSettled(workers);
  const workerFailures: Error[] = [];
  for (let index: number = 0; index < workerSettlements.length; index++) {
    const settlement: PromiseSettledResult<void> = workerSettlements[index]!;
    if (settlement.status === "rejected") {
      workerFailures.push(new Error(`Bounded batch worker ${index} rejected unexpectedly.`, {
        cause: settlement.reason,
      }));
    }
  }
  if (workerFailures.length > 0) {
    throw new AggregateError(workerFailures, "Bounded settled batch workers rejected.");
  }

  const completed: BoundedBatchResult<T, R>[] = [];
  for (let index: number = 0; index < results.length; index++) {
    const result: BoundedBatchResult<T, R> | undefined = results[index];
    if (result === undefined) {
      throw new Error(`Bounded settled batch did not produce result ${index}.`);
    }
    completed.push(result);
  }
  return completed;
}
