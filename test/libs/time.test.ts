import { describe, expect, test } from "bun:test";
import { formatTokyoTime } from "../../packages/libs/time";

/**
 * formatTokyoTime 改成固定 UTC+9 算术之后，唯一的正确性依据就是「与原来的
 * Intl 格式器逐字符相同」。参照实现在这里重建一份，逐点对拍。
 *
 * 这条用例同时是那次性能改动的语义护栏：任何人把算术改回去、或者动了拼接
 * 顺序/补零，都会在这里立刻失败。
 */
const REFERENCE_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function reference(timestampMs: number): string {
  return REFERENCE_FORMATTER.format(timestampMs);
}

describe("libs/time formatTokyoTime", () => {
  test("形态就是转录行与落盘用的那一种", () => {
    // 2025-10-09T08:53:20Z = 东京 17:53:20
    expect(formatTokyoTime(1_760_000_000_000)).toBe("2025/10/09 17:53:20");
    expect(formatTokyoTime(1_760_000_000_000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("与 Intl 参照实现在 1970-2100 均匀采样上逐字符一致", () => {
    const end: number = Date.UTC(2100, 0, 1);
    for (let i: number = 0; i < 20_000; i++) {
      const ms: number = Math.floor((i / 20_000) * end);
      expect(formatTokyoTime(ms)).toBe(reference(ms));
    }
  });

  test("与 Intl 参照实现在伪随机散点上逐字符一致", () => {
    const end: number = Date.UTC(2100, 0, 1);
    let state: number = 987_654_321;
    for (let i: number = 0; i < 20_000; i++) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      const ms: number = Math.floor((state / 0x1_0000_0000) * end);
      expect(formatTokyoTime(ms)).toBe(reference(ms));
    }
  });

  test("跨秒、跨分、跨小时、跨日、闰日与年末边界逐毫秒一致", () => {
    const anchors: readonly number[] = [
      // 东京的一天从 UTC 前一天 15:00 开始，跨日边界必须落在这里。
      Date.UTC(2026, 0, 1, 14, 59, 59, 999),
      Date.UTC(2026, 0, 1, 15, 0, 0, 0),
      // 闰年 2 月末
      Date.UTC(2024, 1, 28, 15, 0, 0, 0),
      Date.UTC(2024, 1, 29, 14, 59, 59, 999),
      // 年末跨年
      Date.UTC(2025, 11, 31, 14, 59, 59, 999),
      Date.UTC(2025, 11, 31, 15, 0, 0, 0),
      // 纪元原点附近
      0,
    ];
    for (const anchor of anchors) {
      for (let delta: number = -1_500; delta <= 1_500; delta++) {
        const ms: number = anchor + delta;
        expect(formatTokyoTime(ms)).toBe(reference(ms));
      }
    }
  });

  test("同一秒内的不同毫秒产出同一个串（格式精度到秒）", () => {
    const base: number = Date.UTC(2026, 5, 1, 3, 4, 5, 0);
    expect(formatTokyoTime(base)).toBe(formatTokyoTime(base + 999));
    expect(formatTokyoTime(base + 1_000)).not.toBe(formatTokyoTime(base));
  });

  /**
   * 算术实现成立的前提：东京自 1951 年起不再实行夏令时。1948-1951 那几年
   * 与 Intl 差一小时，本用例把这条边界钉在这里——全部调用点传的都是
   * Date.now() 派生值，落在 1951 之后；将来若要格式化用户提供的历史时间，
   * 这条会提醒你必须换回 Intl 并重测。
   */
  test("边界备案：1948-1951 的日本夏令时区间不在等价范围内", () => {
    const duringJapaneseDst: number = Date.UTC(1950, 6, 1, 3, 0, 0);
    expect(formatTokyoTime(duringJapaneseDst)).toBe("1950/07/01 12:00:00");
    expect(reference(duringJapaneseDst)).toBe("1950/07/01 13:00:00");
  });
});
