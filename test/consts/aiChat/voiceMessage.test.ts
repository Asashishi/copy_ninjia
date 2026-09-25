import { expect, test } from "bun:test";
import { GEMINI_SPEECH_REQUEST_TIMEOUT_MS } from "../../../packages/consts/aiChat/gemini";
import {
  VOICE_OPERATOR_TEXT_MAX_CHARS,
  VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS,
  VOICE_TEXT_MAX_CHARS,
} from "../../../packages/consts/aiChat/voiceMessage";

test("主线程等待覆盖供应商 SDK 总预算并留出排队与编码时间", () => {
  expect(VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS).toBeGreaterThan(GEMINI_SPEECH_REQUEST_TIMEOUT_MS);
});

test("运维台词上限不低于模型台词上限", () => {
  expect(VOICE_OPERATOR_TEXT_MAX_CHARS).toBeGreaterThanOrEqual(VOICE_TEXT_MAX_CHARS);
});
