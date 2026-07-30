import { describe, expect, test } from "bun:test";
import { TimestampDeque } from "../../packages/libs/timestampDeque";
import { trimTimestampWindow } from "../../packages/libs/slidingWindowRateLimit";

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

  test("滑动窗口边界与时钟回拨语义和通用实现一致", () => {
    const queue = new TimestampDeque(8);
    for (const value of [100, 900, 5_002]) queue.push(value);

    trimTimestampWindow(queue, 1_000, 1_000);

    expect(contents(queue)).toEqual([100, 900]);
  });
});
