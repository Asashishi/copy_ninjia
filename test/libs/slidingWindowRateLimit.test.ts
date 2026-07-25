import { describe, expect, test } from "bun:test";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import { tryConsumeSlidingWindow } from "../../packages/libs/slidingWindowRateLimit";

function consume(timestamps: LinkedQueue<number>, now: number, maxCalls: number = 3): boolean {
  return tryConsumeSlidingWindow({ timestamps, windowMs: 1_000, maxCalls, now });
}

/** 队列内容快照，供断言比对；last(size) 即全部元素，保持入队顺序。 */
function contents(timestamps: LinkedQueue<number>): number[] {
  return timestamps.last(timestamps.size);
}

function queueOf(...values: number[]): LinkedQueue<number> {
  const queue = new LinkedQueue<number>();
  for (const value of values) queue.push(value);
  return queue;
}

describe("滑动窗口限流判定", () => {
  test("窗口内用满上限后拒绝，且被拒绝的调用不记账", () => {
    const timestamps = new LinkedQueue<number>();
    expect(consume(timestamps, 100)).toBeTrue();
    expect(consume(timestamps, 200)).toBeTrue();
    expect(consume(timestamps, 300)).toBeTrue();

    expect(consume(timestamps, 400)).toBeFalse();
    expect(consume(timestamps, 500)).toBeFalse();
    // 拒绝不入队，否则后续窗口会被拒绝记录二次占用名额。
    expect(contents(timestamps)).toEqual([100, 200, 300]);
  });

  test("最早一次滑出窗口后立刻释放一个名额", () => {
    const timestamps = new LinkedQueue<number>();
    for (const now of [100, 200, 300]) expect(consume(timestamps, now)).toBeTrue();

    // 窗口边界按 `< now - windowMs` 淘汰：1100 时 100 仍在窗口内。
    expect(consume(timestamps, 1_100)).toBeFalse();
    expect(consume(timestamps, 1_101)).toBeTrue();
    expect(contents(timestamps)).toEqual([200, 300, 1_101]);
  });

  test("时钟回拨时整窗重建，配额不被冻结", () => {
    const timestamps = queueOf(5_000, 5_001, 5_002);
    expect(consume(timestamps, 1_000)).toBeTrue();
    expect(contents(timestamps)).toEqual([1_000]);
  });

  test("整窗清空后 push 仍接在新链上，不会挂回已丢弃的旧队尾", () => {
    const timestamps = queueOf(5_000);
    expect(consume(timestamps, 1_000)).toBeTrue();
    expect(consume(timestamps, 1_001)).toBeTrue();
    expect(contents(timestamps)).toEqual([1_000, 1_001]);
    expect(timestamps.size).toBe(2);
  });

  test("上限为 0 时永远拒绝，不会写入队列", () => {
    const timestamps = new LinkedQueue<number>();
    expect(consume(timestamps, 100, 0)).toBeFalse();
    expect(contents(timestamps)).toEqual([]);
  });
});
