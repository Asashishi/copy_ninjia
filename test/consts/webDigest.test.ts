/** 组稿等待上限与三家实现包单次调用超时的一致性。 */

import { describe, expect, test } from "bun:test";
import { ANTHROPIC_REQUEST_TIMEOUTS_MS } from "../../packages/consts/aiChat/anthropic";
import { GEMINI_REQUEST_TIMEOUTS_MS } from "../../packages/consts/aiChat/gemini";
import { OPENAI_REQUEST_TIMEOUTS_MS } from "../../packages/consts/aiChat/openai";
import {
  WEB_DIGEST_COMPOSE_ATTEMPTS,
  WEB_DIGEST_MODEL_CALL_TIMEOUT_MS,
  WEB_DIGEST_QUEUE_ALLOWANCE_MS,
  WEB_DIGEST_REQUEST_TIMEOUT_MS,
} from "../../packages/consts/webDigest";

describe("web digest 超时", () => {
  test("单次调用上限等于三家 text 与 web_search 档位超时的最大值", () => {
    const tiers: readonly number[] = [GEMINI_REQUEST_TIMEOUTS_MS, OPENAI_REQUEST_TIMEOUTS_MS, ANTHROPIC_REQUEST_TIMEOUTS_MS]
      .flatMap((table: Readonly<Record<string, number>>): number[] => [table.text!, table.web_search!]);
    expect(WEB_DIGEST_MODEL_CALL_TIMEOUT_MS).toBe(Math.max(...tiers));
  });

  test("等待上限覆盖一次检索与全部组稿尝试各跑满单次上限，再留排队余量", () => {
    expect(WEB_DIGEST_REQUEST_TIMEOUT_MS).toBe(
      (1 + WEB_DIGEST_COMPOSE_ATTEMPTS) * WEB_DIGEST_MODEL_CALL_TIMEOUT_MS + WEB_DIGEST_QUEUE_ALLOWANCE_MS
    );
  });
});
