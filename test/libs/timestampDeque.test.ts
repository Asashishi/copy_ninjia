import { describe, expect, test } from "bun:test";
import { TimestampDeque } from "../../packages/libs/timestampDeque";

function contents(queue: TimestampDeque): number[] {
  const values: number[] = [];
  while (queue.size > 0) values.push(queue.shift()!);
  return values;
}

describe("TimestampDeque", () => {
  test("扩容和环形回绕后仍保持先进先出", () => {
    const queue = new TimestampDeque(8, 2);
    queue.push(1);
    queue.push(2);
    expect(queue.shift()).toBe(1);
    queue.push(3);
    queue.push(4);
    queue.push(5);

    expect(queue.peek()).toBe(2);
    expect(queue.peekLast()).toBe(5);
    expect(contents(queue)).toEqual([2, 3, 4, 5]);
  });

  test("pop 从尾部移除，clear 后可复用已扩容的队列", () => {
    const queue = new TimestampDeque(8, 2);
    for (const value of [1, 2, 3, 4]) queue.push(value);
    expect(queue.pop()).toBe(4);
    expect(queue.peekLast()).toBe(3);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
    queue.push(9);
    expect(contents(queue)).toEqual([9]);
  });

  test("达到领域硬上限时拒绝继续增长", () => {
    const queue = new TimestampDeque(2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrow("capacity exceeded");
  });

  test("饱和窗口原地覆盖最早项且不增长", () => {
    const queue = new TimestampDeque(3, 3);
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(queue.pushReplacingOldest(4)).toBe(1);
    expect(queue.size).toBe(3);
    expect(contents(queue)).toEqual([2, 3, 4]);
  });

  test("按值撤销在回绕前后保持顺序", () => {
    const queue = new TimestampDeque(4, 4);
    for (const value of [1, 2, 3, 4]) queue.push(value);
    expect(queue.shift()).toBe(1);
    queue.push(5);

    expect(queue.removeValue(3)).toBeTrue();
    expect(queue.removeValue(99)).toBeFalse();
    expect(contents(queue)).toEqual([2, 4, 5]);
  });

  test("滑动窗口边界与时钟回拨语义和通用实现一致", () => {
    const queue = new TimestampDeque(8);
    for (const value of [100, 900, 5_002]) queue.push(value);

    // 与 slidingWindowRateLimit.ts 的通用实现同一边界定义：保留
    // (now - windowMs, now]，并丢掉时钟回拨后落在未来的队尾。
    queue.trim(1_000, 1_000);

    expect(contents(queue)).toEqual([100, 900]);
  });
});
