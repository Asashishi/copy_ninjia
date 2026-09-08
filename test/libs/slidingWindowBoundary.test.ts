import { describe, expect, test } from "bun:test";
import type { TimestampDeque } from "../../packages/libs/timestampDeque";
import {
  trimSlidingWindowArray,
  trimSlidingWindowArrayInPlace,
} from "../../packages/libs/slidingWindowRateLimit";
import { timestampDequeContents, timestampDequeOf } from "../helpers/timestampDeque";

/**
 * 两种滑动窗口形态的边界对拍。
 *
 * 全仓的窗口边界只有一个定义——TimestampDeque.trim 的半开区间
 * `(now - windowMs, now]`，外加「时钟回拨只丢落在未来的队尾」。随快照落盘的
 * 窗口保持数组形状，但必须与运行时环形缓冲对同一输入给出相同结果。
 *
 * 数组形态有两个实现（返回新数组的 trimSlidingWindowArray 与就地压缩的
 * trimSlidingWindowArrayInPlace），两者的谓词必须逐字一致，因此本文件是**三方**
 * 对拍：deque / 数组 / 就地。就地版额外锁住「原数组被原地改短、且不换对象」。
 */

const WINDOW_MS: number = 1_000;

function trimViaTimestampDeque(values: readonly number[], now: number): number[] {
  const deque: TimestampDeque = timestampDequeOf(values, Math.max(1, values.length));
  deque.trim(WINDOW_MS, now);
  return timestampDequeContents(deque);
}

/** 就地版跑在一份可写副本上；同时断言它没有换掉数组对象。 */
function trimViaInPlace(values: readonly number[], windowMs: number, now: number): number[] {
  const buffer: number[] = [...values];
  const identity: number[] = buffer;
  trimSlidingWindowArrayInPlace(buffer, windowMs, now);
  expect(buffer).toBe(identity);
  return buffer;
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

describe("滑动窗口两种形态的边界一致", () => {
  for (const { name, values, now } of CASES) {
    test(name, () => {
      const viaDeque: number[] = trimViaTimestampDeque(values, now);
      expect(trimSlidingWindowArray({ timestamps: values, windowMs: WINDOW_MS, now })).toEqual(viaDeque);
      expect(trimViaInPlace(values, WINDOW_MS, now)).toEqual(viaDeque);
    });
  }

  test("窗口长度变化时两者仍逐字一致", () => {
    const values: readonly number[] = [1_000, 1_500, 2_000, 2_500, 3_000];
    for (let windowMs: number = 0; windowMs <= 2_500; windowMs += 250) {
      const deque: TimestampDeque = timestampDequeOf(values, values.length);
      deque.trim(windowMs, 3_000);
      const expected: number[] = timestampDequeContents(deque);

      expect(trimSlidingWindowArray({ timestamps: values, windowMs, now: 3_000 })).toEqual(expected);
      expect(trimViaInPlace(values, windowMs, 3_000)).toEqual(expected);
    }
  });

  /**
   * 时钟回拨会让数组不再单调，此时「裁掉任意位置的未来项」与「只裁连续尾段」
   * 才会分道扬镳。deque 只能表达后者，因此这一组只对拍两个数组实现——它们是
   * 同一份持久化窗口的两种写法，必须逐元素相同。
   */
  test("非单调输入下两个数组实现逐元素一致", () => {
    const NON_MONOTONIC: readonly (readonly number[])[] = [
      [100, 200, 50],
      [5_000, 4_000, 6_000, 4_500],
      [4_900, 6_000, 4_950],
      [6_000, 4_900],
      [4_800, 4_900, 5_100, 4_950, 5_000],
    ];
    for (const values of NON_MONOTONIC) {
      for (const now of [60, 4_999, 5_000, 5_001, 6_000]) {
        expect(trimViaInPlace(values, WINDOW_MS, now))
          .toEqual(trimSlidingWindowArray({ timestamps: values, windowMs: WINDOW_MS, now }));
      }
    }
  });

  test("随机输入（含时钟回拨）两个数组实现逐元素一致", () => {
    let seed: number = 20_260_908;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round: number = 0; round < 5_000; round += 1) {
      const length: number = Math.floor(next() * 50);
      const base: number = 1_000_000 + Math.floor(next() * 200_000);
      const values: number[] = [];
      for (let index: number = 0; index < length; index += 1) {
        values.push(base + Math.floor((next() - 0.4) * 120_000));
      }
      const now: number = base + Math.floor((next() - 0.5) * 120_000);
      expect(trimViaInPlace(values, 60_000, now))
        .toEqual(trimSlidingWindowArray({ timestamps: values, windowMs: 60_000, now }));
    }
  });
});
