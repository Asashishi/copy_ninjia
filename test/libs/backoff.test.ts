/** 有上限的指数退避（libs/backoff.ts）。 */

import { expect, test } from "bun:test";
import { cappedExponentialMs } from "../../packages/libs/backoff";

test("第 attempt 次（0 起算）为 base × 2^attempt，封顶 max", () => {
  expect([0, 1, 2, 3, 4].map((attempt: number): number => cappedExponentialMs(100, attempt, 1_000)))
    .toEqual([100, 200, 400, 800, 1_000]);
});

test("次数大到乘积溢出时仍落在封顶值上", () => {
  expect(cappedExponentialMs(100, 5_000, 1_000)).toBe(1_000);
});
