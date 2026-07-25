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

  test("窗口是半开区间 (now - windowMs, now]，边界两侧行为明确", () => {
    // 全仓所有滑动窗口共用这一个边界定义（见 trimSlidingWindow）：曾经各处
    // 写法不一（`<` / `<=` / `>=`），同样的窗口长度差出一个刻度。
    const justInside = queueOf(100, 200, 300);
    // 1099：100 还差 1 毫秒才满一个窗口，仍占着名额。
    expect(consume(justInside, 1_099)).toBeFalse();

    const atBoundary = queueOf(100, 200, 300);
    // 1100：100 恰好满一个窗口，出局并立刻释放名额。
    expect(consume(atBoundary, 1_100)).toBeTrue();
    expect(contents(atBoundary)).toEqual([200, 300, 1_100]);
  });

  test("时钟回拨只丢落在未来的记录，合法历史必须留下", () => {
    // 整窗清空等于把配额清零重来——往回拨 1 毫秒就能凭空换到一整个新窗口。
    const timestamps = queueOf(900, 5_002);
    expect(consume(timestamps, 1_000, 2)).toBeTrue();
    // 900 仍占名额，所以这次必须被拒；若回拨时整窗清空了，这里会错误放行。
    expect(consume(timestamps, 1_000, 2)).toBeFalse();
    expect(contents(timestamps)).toEqual([900, 1_000]);
  });

  test("全部记录都在未来时窗口确实清空，配额不被冻结", () => {
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
