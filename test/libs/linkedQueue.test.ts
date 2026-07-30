import { describe, expect, test } from "bun:test";
import { LinkedQueue } from "../../packages/libs/linkedQueue";

describe("LinkedQueue", () => {
  test("push/shift 按先进先出顺序", () => {
    const q = new LinkedQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.size).toBe(3);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.size).toBe(1);
  });

  test("空队列 shift/peek 返回 undefined", () => {
    const q = new LinkedQueue<number>();
    expect(q.shift()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  test("peek 查看队首但不出队", () => {
    const q = new LinkedQueue<number>();
    q.push(10);
    q.push(20);
    expect(q.peek()).toBe(10);
    expect(q.size).toBe(2);
  });

  test("peekLast 查看队尾但不创建数组或出队", () => {
    const q = new LinkedQueue<number>();
    expect(q.peekLast()).toBeUndefined();
    q.push(10);
    q.push(20);
    expect(q.peekLast()).toBe(20);
    expect(q.size).toBe(2);
  });

  test("clear 整体清空，之后 push 接在新链上而非已丢弃的旧队尾", () => {
    const queue = new LinkedQueue<number>();
    for (const value of [1, 2, 3]) queue.push(value);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.shift()).toBeUndefined();
    expect(queue.last(1)).toEqual([]);

    // tail 未一并清掉的话，这次 push 会挂到旧节点后面，size 与出队顺序都会错。
    queue.push(9);
    expect(queue.size).toBe(1);
    expect(queue.peek()).toBe(9);
    expect(queue.last(3)).toEqual([9]);
  });

  test("空队列 clear 是幂等的", () => {
    const queue = new LinkedQueue<number>();
    queue.clear();
    queue.clear();
    expect(queue.size).toBe(0);
    queue.push(1);
    expect(queue.shift()).toBe(1);
  });

  test("last(n) 取队尾最近 n 个，保持入队顺序；n 超出长度时返回全部", () => {
    const q = new LinkedQueue<number>();
    [1, 2, 3, 4, 5].forEach((v) => q.push(v));
    expect(q.last(2)).toEqual([4, 5]);
    expect(q.last(10)).toEqual([1, 2, 3, 4, 5]);
  });

  describe("removeValue", () => {
    test("移除队首节点，队列继续正常出队", () => {
      const q = new LinkedQueue<number>();
      [1, 2, 3].forEach((v) => q.push(v));
      expect(q.removeValue(1)).toBe(true);
      expect(q.size).toBe(2);
      expect(q.last(2)).toEqual([2, 3]);
      expect(q.shift()).toBe(2);
    });

    test("移除队尾节点，tail 指针正确更新（之后 push 不会接到已摘除的旧节点上）", () => {
      const q = new LinkedQueue<number>();
      [1, 2, 3].forEach((v) => q.push(v));
      expect(q.removeValue(3)).toBe(true);
      expect(q.size).toBe(2);
      q.push(4);
      expect(q.last(3)).toEqual([1, 2, 4]);
    });

    test("移除中间节点，不影响其余元素的相对顺序", () => {
      const q = new LinkedQueue<number>();
      [1, 2, 3, 4].forEach((v) => q.push(v));
      expect(q.removeValue(2)).toBe(true);
      expect(q.last(3)).toEqual([1, 3, 4]);
    });

    test("值不存在时返回 false，不改动队列", () => {
      const q = new LinkedQueue<number>();
      [1, 2, 3].forEach((v) => q.push(v));
      expect(q.removeValue(999)).toBe(false);
      expect(q.size).toBe(3);
      expect(q.last(3)).toEqual([1, 2, 3]);
    });

    test("空队列移除任何值都返回 false", () => {
      const q = new LinkedQueue<number>();
      expect(q.removeValue(1)).toBe(false);
    });

    test("重复值只移除按扫描顺序命中的第一个", () => {
      const q = new LinkedQueue<number>();
      [5, 5, 5].forEach((v) => q.push(v));
      expect(q.removeValue(5)).toBe(true);
      expect(q.size).toBe(2);
    });

    test("移除唯一节点后队列变空，size/peek/shift 均正确反映", () => {
      const q = new LinkedQueue<number>();
      q.push(42);
      expect(q.removeValue(42)).toBe(true);
      expect(q.size).toBe(0);
      expect(q.peek()).toBeUndefined();
      expect(q.shift()).toBeUndefined();
      q.push(7);
      expect(q.peek()).toBe(7);
    });
  });

  describe("removeWhere", () => {
    test("一次移除头中尾多个节点并保持其余顺序", () => {
      const queue = new LinkedQueue<number>();
      [1, 2, 3, 4, 5, 6].forEach((value: number): void => queue.push(value));

      expect(queue.removeWhere((value: number): boolean => value % 2 === 0)).toBe(3);
      expect(queue.size).toBe(3);
      expect(queue.last(3)).toEqual([1, 3, 5]);
      expect(queue.shift()).toBe(1);
      expect(queue.shift()).toBe(3);
      expect(queue.shift()).toBe(5);
    });

    test("全删与零命中都正确维护 head/tail", () => {
      const queue = new LinkedQueue<number>();
      [1, 2].forEach((value: number): void => queue.push(value));
      expect(queue.removeWhere((): boolean => false)).toBe(0);
      expect(queue.last(2)).toEqual([1, 2]);

      expect(queue.removeWhere((): boolean => true)).toBe(2);
      expect(queue.size).toBe(0);
      queue.push(9);
      expect(queue.peek()).toBe(9);
      expect(queue.last(1)).toEqual([9]);
    });
  });
});
