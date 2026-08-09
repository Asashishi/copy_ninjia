/** test/libs 下多个测试文件共用的小工具（非测试文件，bun test 不会执行它）。 */

/** 手动控制 settle 时机的 Promise，串行/并发调度类测试用。 */
export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 按给定分块流式返回 body 的 Response，流式读取/字节上限类测试用。 */
export function chunkedResponse(chunks: readonly Uint8Array[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}

/**
 * 测试里的固定小批并发统一等待全部结算；失败项按输入下标聚合，避免 allSettled
 * 被误用成吞错。调用方只传已经启动的 Promise，本函数不扩大生产并发面。
 */
export async function settleTestBatch<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settlements: PromiseSettledResult<T>[] = await Promise.allSettled(tasks);
  const failures: Error[] = [];
  const values: T[] = [];
  for (let index: number = 0; index < settlements.length; index++) {
    const settlement: PromiseSettledResult<T> = settlements[index]!;
    if (settlement.status === "fulfilled") {
      values.push(settlement.value);
    } else {
      failures.push(new Error(`Test batch task ${index} rejected.`, {
        cause: settlement.reason,
      }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test batch tasks rejected.");
  }
  return values;
}
