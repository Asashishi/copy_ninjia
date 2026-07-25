import { afterEach, describe, expect, test } from "bun:test";
import { recentCallTimestamps } from "../../packages/cache/luckChallenge";
import { tryConsumeLuckRateLimit } from "../../packages/commands/luckChallenge/rateLimit";
import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../packages/consts/luckChallenge";

afterEach(() => { recentCallTimestamps.length = 0; });

describe("运势全局滑动窗口", () => {
  test("恰在上限时遇到小回拨，清空旧窗口并从当前时刻恢复", () => {
    const now = 1_000_000;
    recentCallTimestamps.push(
      ...Array.from({ length: RATE_LIMIT_MAX_CALLS_PER_WINDOW }, () => now + 1)
    );

    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
    expect(recentCallTimestamps).toEqual([now]);
    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
  });

  test("大回拨后不冻结配额，新窗口仍按期清理", () => {
    const now = 10_000;
    recentCallTimestamps.push(now + RATE_LIMIT_WINDOW_MS * 100);

    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
    expect(recentCallTimestamps).toEqual([now]);
    expect(tryConsumeLuckRateLimit(now + RATE_LIMIT_WINDOW_MS + 1)).toBeTrue();
    expect(recentCallTimestamps).toEqual([now + RATE_LIMIT_WINDOW_MS + 1]);
  });
});
