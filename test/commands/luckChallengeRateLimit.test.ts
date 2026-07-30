import { afterEach, describe, expect, test } from "bun:test";
import { recentCallTimestamps } from "../../packages/cache/main/luckChallenge";
import { tryConsumeLuckRateLimit } from "../../packages/commands/luckChallenge/rateLimit";
import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../packages/consts/luckChallenge";

afterEach(() => { recentCallTimestamps.clear(); });

/** 队列内容快照：窗口是 LinkedQueue，断言前先摊平成数组。 */
function windowContents(): number[] {
  return recentCallTimestamps.last(recentCallTimestamps.size);
}

describe("运势全局滑动窗口", () => {
  test("恰在上限时遇到小回拨，清空旧窗口并从当前时刻恢复", () => {
    const now = 1_000_000;
    for (let filled = 0; filled < RATE_LIMIT_MAX_CALLS_PER_WINDOW; filled++) {
      recentCallTimestamps.push(now + 1);
    }

    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
    expect(windowContents()).toEqual([now]);
    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
  });

  test("大回拨后不冻结配额，新窗口仍按期清理", () => {
    const now = 10_000;
    recentCallTimestamps.push(now + RATE_LIMIT_WINDOW_MS * 100);

    expect(tryConsumeLuckRateLimit(now)).toBeTrue();
    expect(windowContents()).toEqual([now]);
    expect(tryConsumeLuckRateLimit(now + RATE_LIMIT_WINDOW_MS + 1)).toBeTrue();
    expect(windowContents()).toEqual([now + RATE_LIMIT_WINDOW_MS + 1]);
  });
});
