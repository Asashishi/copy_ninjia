import { describe, expect, test } from "bun:test";
import {
  createMonotonicDeadline,
  isMonotonicDeadlineExpired,
  remainingMonotonicTime,
} from "../../packages/libs/monotonicDeadline";

describe("monotonic deadline", () => {
  test("只读取注入的单调时钟，墙钟回拨不会增加预算", () => {
    let monotonicTime: number = 1_000;
    let wallTime: number = 500_000;
    const clock = (): number => monotonicTime;
    const deadline: number = createMonotonicDeadline(100, clock);

    wallTime -= 300_000;
    monotonicTime += 40;

    expect(wallTime).toBe(200_000);
    expect(remainingMonotonicTime(deadline, clock)).toBe(60);
    monotonicTime += 60;
    expect(isMonotonicDeadlineExpired(deadline, clock)).toBeTrue();
  });

  test("零预算与负预算立即到期，到期后剩余值稳定为零", () => {
    let monotonicTime: number = 10;
    const clock = (): number => monotonicTime;
    const zeroDeadline: number = createMonotonicDeadline(0, clock);
    const negativeDeadline: number = createMonotonicDeadline(-1, clock);

    expect(isMonotonicDeadlineExpired(zeroDeadline, clock)).toBeTrue();
    expect(isMonotonicDeadlineExpired(negativeDeadline, clock)).toBeTrue();
    monotonicTime += 1_000;
    expect(remainingMonotonicTime(zeroDeadline, clock)).toBe(0);
  });
});
