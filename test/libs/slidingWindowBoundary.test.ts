import { describe, expect, test } from "bun:test";
import { LinkedQueue } from "../../packages/libs/linkedQueue";
import type { TimestampDeque } from "../../packages/libs/timestampDeque";
import {
  trimSlidingWindow,
  trimSlidingWindowArray,
} from "../../packages/libs/slidingWindowRateLimit";
import { timestampDequeContents, timestampDequeOf } from "../helpers/timestampDeque";

/**
 * 三种滑动窗口形态的边界对拍。
 *
 * 全仓的窗口边界只有一个定义——TimestampDeque.trim 的半开区间
 * `(now - windowMs, now]`，外加「时钟回拨只丢落在未来的队尾」。另外两种形态
 * 各自有非用不可的理由（无硬顶窗口只能用可无界增长的 LinkedQueue；随快照落盘
 * 的窗口只能是数组），因此实现无法合并，但三者对同一输入必须给出逐字相同的
 * 结果。本文件就是这条约束的机器可判形式：任何一侧把 `<=` 写成 `<`、或在回拨
 * 时整窗清空，都会在这里立刻失败。
 */

const WINDOW_MS: number = 1_000;

function trimViaLinkedQueue(values: readonly number[], now: number): number[] {
  const timestamps: LinkedQueue<number> = new LinkedQueue<number>();
  for (const value of values) timestamps.push(value);
  trimSlidingWindow({ timestamps, windowMs: WINDOW_MS, now });
  return timestamps.last(timestamps.size);
}

function trimViaTimestampDeque(values: readonly number[], now: number): number[] {
  const deque: TimestampDeque = timestampDequeOf(values, Math.max(1, values.length));
  deque.trim(WINDOW_MS, now);
  return timestampDequeContents(deque);
}

/** 升序时间戳的输入矩阵：覆盖两侧边界、全过期、全未来、回拨后尾段越界。 */
const CASES: readonly { readonly name: string; readonly values: readonly number[]; readonly now: number }[] = [
  { name: "空窗口", values: [], now: 5_000 },
  { name: "全部在窗口内", values: [4_500, 4_800, 5_000], now: 5_000 },
  { name: "队首恰好出局（ts === now - windowMs）", values: [4_000, 4_001], now: 5_000 },
  { name: "队首差一刻度仍在窗口内（ts === now - windowMs + 1）", values: [4_001, 4_002], now: 5_000 },
  { name: "队尾恰好等于 now，属于窗口内", values: [4_500, 5_000], now: 5_000 },
  { name: "全部过期", values: [100, 200, 300], now: 5_000 },
  { name: "全部落在未来（整窗回拨）", values: [6_000, 6_001, 6_002], now: 5_000 },
  { name: "回拨后只有尾段越界，合法历史必须留下", values: [4_900, 6_000], now: 5_000 },
  { name: "回拨后尾段越界且队首同时过期", values: [100, 4_900, 6_000, 7_000], now: 5_000 },
  { name: "重复时间戳", values: [4_000, 4_000, 4_001, 4_001], now: 5_000 },
  { name: "now 为 0", values: [0], now: 0 },
];

describe("滑动窗口三种形态的边界一致", () => {
  for (const { name, values, now } of CASES) {
    test(name, () => {
      const viaDeque: number[] = trimViaTimestampDeque(values, now);
      expect(trimViaLinkedQueue(values, now)).toEqual(viaDeque);
      expect(trimSlidingWindowArray({ timestamps: values, windowMs: WINDOW_MS, now })).toEqual(viaDeque);
    });
  }

  test("窗口长度变化时三者仍逐字一致", () => {
    const values: readonly number[] = [1_000, 1_500, 2_000, 2_500, 3_000];
    for (let windowMs: number = 0; windowMs <= 2_500; windowMs += 250) {
      const deque: TimestampDeque = timestampDequeOf(values, values.length);
      deque.trim(windowMs, 3_000);
      const expected: number[] = timestampDequeContents(deque);

      const queue: LinkedQueue<number> = new LinkedQueue<number>();
      for (const value of values) queue.push(value);
      trimSlidingWindow({ timestamps: queue, windowMs, now: 3_000 });

      expect(queue.last(queue.size)).toEqual(expected);
      expect(trimSlidingWindowArray({ timestamps: values, windowMs, now: 3_000 })).toEqual(expected);
    }
  });
});
