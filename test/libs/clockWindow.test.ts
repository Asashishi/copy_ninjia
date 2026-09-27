import { describe, expect, test } from "bun:test";
import { isPendingWithin, isRecordedWithin } from "../../packages/libs/clockWindow";

describe("墙钟时间窗判定", () => {
  test("记录时刻起的经过时长落在 [0, maxAgeMs] 内才算仍在窗口内", () => {
    expect(isRecordedWithin(1_000, 1_000, 500)).toBeTrue();
    expect(isRecordedWithin(1_000, 1_500, 500)).toBeTrue();
    expect(isRecordedWithin(1_000, 1_501, 500)).toBeFalse();
  });

  test("墙钟回拨到记录时刻之前时按已过期处理，不等回拨量走完", () => {
    expect(isRecordedWithin(1_000, 999, 500)).toBeFalse();
  });

  test("截止时刻在 now 之后且不超过最大延迟时才算仍在等待", () => {
    expect(isPendingWithin(1_500, 1_000, 500)).toBeTrue();
    expect(isPendingWithin(1_000, 1_000, 500)).toBeFalse();
    expect(isPendingWithin(999, 1_000, 500)).toBeFalse();
  });

  test("墙钟回拨让截止时刻远于最大延迟时按已到期处理", () => {
    expect(isPendingWithin(1_501, 1_000, 500)).toBeFalse();
  });
});
