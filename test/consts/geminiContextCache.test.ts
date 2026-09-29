/** Gemini 显式缓存共用常量之间的关系：续期档、最少剩余存活与冷却必须落在 TTL 之内。 */

import { expect, test } from "bun:test";
import {
  GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS,
  GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS,
  GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS,
  GEMINI_CONTEXT_CACHE_TTL_SECONDS,
} from "../../packages/consts/geminiContextCache";

test("新条目出生时剩余存活高于续期档与最少剩余之和", () => {
  expect(GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS + GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS)
    .toBeLessThan(GEMINI_CONTEXT_CACHE_TTL_SECONDS * 1_000);
});

test("续期失败冷却短于续期窗口：条目过期前至少还有一次重试", () => {
  expect(GEMINI_CONTEXT_CACHE_RETRY_AFTER_MS)
    .toBeLessThan(GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS - GEMINI_CONTEXT_CACHE_MIN_REMAINING_MS);
});
