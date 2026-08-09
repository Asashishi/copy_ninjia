import { describe, expect, test } from "bun:test";
import { AcknowledgedBatchQueue } from "../../packages/libs/acknowledgedBatchQueue";
import type { AcknowledgedBatch } from "../../packages/libs/acknowledgedBatchQueue";

describe("AcknowledgedBatchQueue", () => {
  test("单批受硬顶约束，ACK 前不开放下一批，结果保持 FIFO", () => {
    const queue: AcknowledgedBatchQueue<string> = new AcknowledgedBatchQueue<string>(2);
    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");

    const first: AcknowledgedBatch<string> | null = queue.nextDelivery();
    expect(first).toEqual({ batchId: 1, values: ["first", "second"] });
    expect(queue.size).toBe(3);
    expect(queue.markDelivered(first!.batchId)).toBe(true);
    expect(queue.awaitingAcknowledgement).toBe(true);
    expect(queue.nextDelivery()).toBeNull();
    expect(queue.acknowledge(999)).toBe(false);
    expect(queue.acknowledge(first!.batchId)).toBe(true);

    const second: AcknowledgedBatch<string> | null = queue.nextDelivery();
    expect(second).toEqual({ batchId: 2, values: ["third"] });
    expect(queue.size).toBe(1);
  });

  test("同步拒收、显式重投与迟到 ACK 都只作用于当前原批", () => {
    const queue: AcknowledgedBatchQueue<number> = new AcknowledgedBatchQueue<number>(1);
    queue.enqueue(10);
    queue.enqueue(20);

    const first: AcknowledgedBatch<number> = queue.nextDelivery()!;
    queue.markDeliveryRejected();
    expect(queue.nextDelivery()).toBe(first);
    expect(queue.markDelivered(first.batchId)).toBe(true);
    expect(queue.requestRedelivery(999)).toBe(false);
    expect(queue.requestRedelivery(first.batchId)).toBe(true);
    expect(queue.nextDelivery()).toBe(first);
    expect(queue.markDelivered(first.batchId)).toBe(true);
    expect(queue.acknowledge(first.batchId)).toBe(true);

    const second: AcknowledgedBatch<number> = queue.nextDelivery()!;
    expect(queue.acknowledge(first.batchId)).toBe(false);
    expect(queue.markDelivered(second.batchId)).toBe(true);
    expect(queue.acknowledge(second.batchId)).toBe(true);
    expect(queue.size).toBe(0);
  });

  test("reset 释放引用并恢复协议初态", () => {
    const queue: AcknowledgedBatchQueue<object> = new AcknowledgedBatchQueue<object>(1);
    queue.enqueue({ value: 1 });
    const batch: AcknowledgedBatch<object> = queue.nextDelivery()!;
    expect(queue.markDelivered(batch.batchId)).toBe(true);

    queue.reset();

    expect(queue.size).toBe(0);
    expect(queue.awaitingAcknowledgement).toBe(false);
    expect(queue.nextDelivery()).toBeNull();
    queue.enqueue({ value: 2 });
    expect(queue.nextDelivery()?.batchId).toBe(1);
  });

  test("拒绝不能推进 FIFO 的非法批次上限", () => {
    expect((): AcknowledgedBatchQueue<number> =>
      new AcknowledgedBatchQueue<number>(0)
    ).toThrow("positive safe integer");
    expect((): AcknowledgedBatchQueue<number> =>
      new AcknowledgedBatchQueue<number>(1.5)
    ).toThrow("positive safe integer");
  });

  test("批次句柄只允许编译期读取", () => {
    const queue: AcknowledgedBatchQueue<number> = new AcknowledgedBatchQueue<number>(1);
    queue.enqueue(1);
    const batch: AcknowledgedBatch<number> = queue.nextDelivery()!;
    expect(batch.values).toEqual([1]);
    const assertReadOnly: () => void = (): void => {
      // @ts-expect-error 构造后 batchId 不允许被调用方改写。
      batch.batchId = 2;
      // @ts-expect-error 在途值由队列持有，调用方不得改变 ACK 对应的批次内容。
      batch.values.push(2);
    };
    expect(assertReadOnly).toBeInstanceOf(Function);
  });
});
