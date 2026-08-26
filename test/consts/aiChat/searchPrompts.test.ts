/** 联网查证固定文案的供应商中立性与决策边界。 */

import { describe, expect, test } from "bun:test";
import {
  WEB_SEARCH_INSTRUCTION,
  WEB_SEARCH_TOOL_LABEL,
} from "../../../packages/consts/aiChat/prompts/search";

/** 两家服务端检索工具的真名；任何一个出现在提示词里都是 bug。 */
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
});
