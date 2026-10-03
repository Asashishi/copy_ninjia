/** 联网查证固定文案的供应商中立性与决策边界。 */

import { describe, expect, test } from "bun:test";
import {
  WEB_SEARCH_INSTRUCTION,
  WEB_SEARCH_FUNCTION_INSTRUCTION,
  WEB_SEARCH_TOOL_LABEL,
} from "../../../packages/consts/aiChat/prompts/search";
import { MAX_WEB_SEARCH_CALLS_PER_REPLY } from "../../../packages/consts/aiChat/tools";
import { TOOL_STATUS_POINTER } from "../../../packages/consts/aiChat/prompts/tools";

/** 供应商服务端检索工具的名称；内建检索说明只使用统一中立称呼。 */
const PROVIDER_TOOL_NAMES: readonly string[] = ["googleSearch", "web_search", "Google Search"];

describe("联网查证文案不绑定任何一家供应商", () => {
  test("固定文案不出现供应商的工具真名", () => {
    for (const name of PROVIDER_TOOL_NAMES) {
      expect(WEB_SEARCH_INSTRUCTION).not.toContain(name);
    }
  });

  test("固定文案用统一的中立称呼指代检索工具", () => {
    expect(WEB_SEARCH_INSTRUCTION).toContain(WEB_SEARCH_TOOL_LABEL);
  });

  test("区分需查事实与只依赖转录的内容，并约束证据不足时不补造", () => {
    expect(WEB_SEARCH_INSTRUCTION).toContain("会变化的现实信息");
    expect(WEB_SEARCH_INSTRUCTION).toContain("转录中已经给出的事实不搜索");
    expect(WEB_SEARCH_INSTRUCTION).toContain("搜索结果优先于记忆");
    expect(WEB_SEARCH_INSTRUCTION).toContain("证据不足或没有检索工具时就明确不确定，不得补造");
  });

  test("text 内建搜索按固定软预算说明；独立函数从本轮工具状态读取配置上限", () => {
    const builtInLimit: string = `同一轮回复最多检索 ${MAX_WEB_SEARCH_CALLS_PER_REPLY} 次`;
    expect(WEB_SEARCH_INSTRUCTION).toContain(builtInLimit);
    expect(WEB_SEARCH_FUNCTION_INSTRUCTION).not.toContain(builtInLimit);
    expect(WEB_SEARCH_FUNCTION_INSTRUCTION).toContain(TOOL_STATUS_POINTER);
    expect(WEB_SEARCH_FUNCTION_INSTRUCTION).toContain("达到上限就凭手头材料作答，不要再调用");
  });
});
