import { afterEach, describe, expect, test } from "bun:test";
import { diskIOOperationTail } from
  "../../../packages/cache/workers/diskIO/recovery";
import { enqueueDiskIOOperation } from
  "../../../packages/workers/diskIO/operationQueue";

afterEach(() => {
  diskIOOperationTail.current = Promise.resolve();
});

describe("Disk I/O Worker 异步操作队列", () => {
  test("高 churn 后只保留已结算尾节点，Worker 重建可恢复空队列", async () => {
    const operationCount: number = 20_000;
    let completed: number = 0;
    let last: Promise<void> = Promise.resolve();

    for (let index: number = 0; index < operationCount; index += 1) {
      last = enqueueDiskIOOperation((): void => {
        completed += 1;
      });
    }

    expect(diskIOOperationTail.current).toBe(last);
    await last;
    expect(completed).toBe(operationCount);

    const rebuiltTail: Promise<void> = Promise.resolve();
    diskIOOperationTail.current = rebuiltTail;
    expect(diskIOOperationTail.current).toBe(rebuiltTail);
    await expect(diskIOOperationTail.current).resolves.toBeUndefined();
  });
});
