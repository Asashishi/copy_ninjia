import { describe, expect, test } from "bun:test";
import { extractFunctionCalls, extractOutputText, isTruncatedByTokenLimit } from "../../../src/ai/utils/geminiResponse";

/** 按 generateContent 响应形状裁剪的夹具（思考段/正文段/functionCall 混排）。 */
const RESPONSE_FIXTURE = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "thinking...", thought: true },
          { text: "今天东京" },
          { text: "晴。" },
          { functionCall: { id: "call-abc-0", name: "get_current_time", args: {} } },
          { text: "热死了。" },
        ],
      },
      finishReason: "STOP",
    },
  ],
};

describe("ai/utils/geminiResponse", () => {
  test("extractOutputText：按序拼接全部非思考 text 段（thought: true 的不算正文）", () => {
    expect(extractOutputText(RESPONSE_FIXTURE)).toBe("今天东京晴。热死了。");
  });

  test("extractOutputText：无 text 段 / 形状异常时返回空串", () => {
    expect(extractOutputText({ candidates: [{ content: { parts: [{ thought: true, text: "只想不说" }] } }] })).toBe("");
    expect(extractOutputText({ candidates: [] })).toBe("");
    expect(extractOutputText({})).toBe("");
    expect(extractOutputText(null)).toBe("");
  });

  test("extractFunctionCalls：只取带 functionCall 的 part，返回 functionCall 对象本身", () => {
    const calls = extractFunctionCalls(RESPONSE_FIXTURE);
    expect(calls.length).toBe(1);
    expect(calls[0]!.id).toBe("call-abc-0");
    expect(calls[0]!.name).toBe("get_current_time");
    expect(calls[0]!.args).toEqual({});
  });

  test("extractFunctionCalls：无调用时返回空数组", () => {
    expect(extractFunctionCalls({ candidates: [{ content: { parts: [] } }] })).toEqual([]);
    expect(extractFunctionCalls(undefined)).toEqual([]);
  });

  test("isTruncatedByTokenLimit：只认 finishReason=MAX_TOKENS", () => {
    expect(isTruncatedByTokenLimit(RESPONSE_FIXTURE)).toBe(false);
    expect(isTruncatedByTokenLimit({ candidates: [{ finishReason: "MAX_TOKENS" }] })).toBe(true);
    expect(isTruncatedByTokenLimit({ candidates: [{ finishReason: "SAFETY" }] })).toBe(false);
    expect(isTruncatedByTokenLimit(undefined)).toBe(false);
  });
});
