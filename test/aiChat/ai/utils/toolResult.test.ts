/** 工具结果的单次解析：动作额度与失败说明。 */

import { describe, expect, test } from "bun:test";
import { DUPLICATE_REPLY_RESULT } from "../../../../packages/consts/aiChat/tools";
import { parseToolResult, toolError } from "../../../../packages/aiChat/ai/utils/toolResult";

describe("parseToolResult", () => {
  test("成功结果按 actions_used 占额度，缺省为 1", () => {
    expect(parseToolResult(JSON.stringify({ success: true, actions_used: 2 }))).toEqual({ actionsUsed: 2, error: null });
    expect(parseToolResult(JSON.stringify({ success: true }))).toEqual({ actionsUsed: 1, error: null });
  });

  test("重复跳过不占额度", () => {
    expect(parseToolResult(DUPLICATE_REPLY_RESULT)).toEqual({ actionsUsed: 0, error: null });
  });

  test("失败结果不占额度并带出说明；附加字段不影响解析", () => {
    expect(parseToolResult(toolError("fixture failure"))).toEqual({ actionsUsed: 0, error: "fixture failure" });
    expect(parseToolResult(toolError("fixture retry", { retryable: true }))).toEqual({ actionsUsed: 0, error: "fixture retry" });
  });

  test("error 不是字符串时不算失败说明", () => {
    expect(parseToolResult(JSON.stringify({ error: 1 }))).toEqual({ actionsUsed: 0, error: null });
  });
});
