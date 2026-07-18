import { describe, expect, test } from "bun:test";
import { LinkedQueue } from "../../src/libs/linkedQueue";

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
});
