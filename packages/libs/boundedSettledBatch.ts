/** 一个批任务的执行上下文：原输入与它在输入数组中的下标。 */
export interface BoundedBatchExecution<T> {
  readonly item: T;
  readonly index: number;
}

/** 有界批处理的成功结果；保留原输入和下标供调用方追踪。 */
export interface BoundedBatchFulfilled<T, R> extends BoundedBatchExecution<T> {
  readonly status: "fulfilled";
  readonly value: R;
}

/** 有界批处理的失败结果；保留原输入、下标和错误供调用方逐项结算。 */
export interface BoundedBatchRejected<T> extends BoundedBatchExecution<T> {
  readonly status: "rejected";
  readonly reason: unknown;
}

/** 有界批处理逐项结果；数组顺序始终与输入顺序一致。 */
export type BoundedBatchResult<T, R> =
  | BoundedBatchFulfilled<T, R>
  | BoundedBatchRejected<T>;

/** 有界并发批处理的参数。 */
export interface RunBoundedSettledBatchOptions<T, R> {
  readonly items: readonly T[];
  readonly maxConcurrent: number;
  readonly execute: (execution: BoundedBatchExecution<T>) => Promise<R>;
}

/**
 * 用固定 worker 数消费一批任务，并返回与输入同序的逐项 settlement。
 *
 * 动态输入不得直接 `map` 成整批 Promise：本函数只启动 maxConcurrent 个 worker，
 * 每项只执行一次；`execute` 同步抛出或 reject 都只把该项结算为失败，不截断其它输入。
 * worker 汇合等待全部结算。
 */
export async function runBoundedSettledBatch<T, R>({
  items,
  maxConcurrent,
  execute,
}: RunBoundedSettledBatchOptions<T, R>): Promise<BoundedBatchResult<T, R>[]> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  if (items.length === 0) return [];

  // 每个下标恰好由领到它的 worker 写入一次，汇合时数组已填满。
  const results: BoundedBatchResult<T, R>[] = new Array<BoundedBatchResult<T, R>>(items.length);
  let nextIndex: number = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index: number = nextIndex++;
      const item: T = items[index]!;
      try {
        const value: R = await execute({ item, index });
        results[index] = { item, index, status: "fulfilled", value };
      } catch (error: unknown) {
        results[index] = { item, index, status: "rejected", reason: error };
      }
    }
  }

  const workerCount: number = Math.min(maxConcurrent, items.length);
  const workers: Promise<void>[] = [];
  for (let index: number = 0; index < workerCount; index++) {
    workers.push(runWorker());
  }
  // worker 内部按项结算 execute 的同步抛错与 reject，自身不会 reject。
  await Promise.allSettled(workers);
  return results;
}
