import { describe, expect, test } from "bun:test";
import { BoundedDeque } from "../../packages/libs/boundedDeque";

describe("BoundedDeque", () => {
  test("扩容和环形回绕后 last/shift 保持顺序", () => {
    const queue = new BoundedDeque<object>(8, 2);
    const values: object[] = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    queue.push(values[0]!);
    queue.push(values[1]!);
    expect(queue.shift()).toBe(values[0]);
    queue.push(values[2]!);
    queue.push(values[3]!);

    expect(queue.last(2)).toEqual([values[2]!, values[3]!]);
    expect(queue.last(10)).toEqual([values[1]!, values[2]!, values[3]!]);
    expect(queue.shift()).toBe(values[1]);
  });

  test("clear 后队列可复用且不返回旧引用", () => {
    const queue = new BoundedDeque<object>(4);
    queue.push({ id: 1 });
    queue.push({ id: 2 });
    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(queue.last(4)).toEqual([]);
    const current: object = { id: 3 };
    queue.push(current);
    expect(queue.last(1)).toEqual([current]);
  });

  test("达到领域硬上限时拒绝继续增长", () => {
    const queue = new BoundedDeque<number>(2);
    queue.push(1);
    queue.push(2);
    expect(() => queue.push(3)).toThrow("capacity exceeded");
  });
});
