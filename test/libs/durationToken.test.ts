import { describe, expect, test } from "bun:test";
import {
  formatDurationCn,
  parseDurationTokenMs,
} from "../../packages/libs/durationToken";

describe("时长 token 解析", () => {
  test("按 m/h/d 三个单位换算成毫秒", () => {
    expect(parseDurationTokenMs("10m")).toBe(10 * 60_000);
    expect(parseDurationTokenMs("90M")).toBe(90 * 60_000);
    expect(parseDurationTokenMs("2h")).toBe(2 * 60 * 60_000);
    expect(parseDurationTokenMs("365D")).toBe(365 * 24 * 60 * 60_000);
  });

  test("形态不合法一律返回 undefined，不做区间判定", () => {
    for (const invalid of [
      "",
      "10",
      "m",
      "1.5h",
      "0m",
      "-5m",
      "10s",
      "10 m",
      "h10",
      "010m",
    ]) {
      expect(parseDurationTokenMs(invalid)).toBeUndefined();
    }
    // 区间留给 /mute 的收敛与 /batch_kick 的拒绝，本模块只看形态。
    expect(parseDurationTokenMs("999d")).toBe(999 * 24 * 60 * 60_000);
  });
});

describe("时长中文渲染", () => {
  test("取能整除的最大单位，不替用户换算进位", () => {
    expect(formatDurationCn(10 * 60_000)).toBe("10 分钟");
    expect(formatDurationCn(30 * 60_000)).toBe("30 分钟");
    expect(formatDurationCn(90 * 60_000)).toBe("90 分钟");
    expect(formatDurationCn(2 * 60 * 60_000)).toBe("2 小时");
    expect(formatDurationCn(24 * 60 * 60_000)).toBe("1 天");
    expect(formatDurationCn(365 * 24 * 60 * 60_000)).toBe("365 天");
  });
});
