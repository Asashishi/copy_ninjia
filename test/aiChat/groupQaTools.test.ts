import { describe, expect, test } from "bun:test";
import {
  buildGroupQaToolDefinitions,
  executeGroupQaAnswer,
  executeGroupQaQuery,
} from "../../packages/aiChat/ai/tools/replyToolset/groupQa";
import { TOOL_STATUS_POINTER } from "../../packages/consts/aiChat/prompts/tools";
import { GROUP_QA_ANSWER_TOOL, GROUP_QA_QUERY_TOOL } from "../../packages/consts/tools";

const ENTRIES: ReadonlyMap<string, string> = new Map([
  ["怎么入群？", "点置顶那条链接"],
  ["几点开饭", "十一点半"],
]);

describe("群问答的两个模型工具", () => {
  test("两个纯查询工具恒挂、逐字恒定，都不占动作预算，并指向本轮工具状态", async () => {
    const definitions = buildGroupQaToolDefinitions();
    expect(definitions.map((d) => d.name)).toEqual([GROUP_QA_QUERY_TOOL, GROUP_QA_ANSWER_TOOL]);
    expect(JSON.stringify(buildGroupQaToolDefinitions())).toBe(JSON.stringify(definitions));
    expect(definitions[0]!.description).toContain(TOOL_STATUS_POINTER);
    // 校验这两个工具名不在 ACTION_TOOL_NAMES 动作预算清单中。
    const { ACTION_TOOL_NAMES } = await import("../../packages/consts/tools");
    for (const definition of definitions) {
      expect(ACTION_TOOL_NAMES).not.toContain(definition.name);
    }
  });

  test("本群没登记问答时 query 返回空清单、answer 如实未找到", () => {
    expect(JSON.parse(executeGroupQaQuery(undefined))).toEqual({ questions: [] });
    expect(JSON.parse(executeGroupQaAnswer(undefined, JSON.stringify({ question: "怎么入群？" }))))
      .toEqual({ found: false, question: "怎么入群？" });
  });

  test("query 只给问题清单，不泄漏答案", () => {
    const parsed: { questions: string[] } = JSON.parse(executeGroupQaQuery(ENTRIES));

    expect(parsed.questions).toEqual(["怎么入群？", "几点开饭"]);
    // query 的返回文本中不出现任何答案内容。
    expect(executeGroupQaQuery(ENTRIES)).not.toContain("点置顶那条链接");
  });

  test("answer 按原文取回答案", () => {
    const parsed: { found: boolean; answer?: string } = JSON.parse(
      executeGroupQaAnswer(ENTRIES, JSON.stringify({ question: "怎么入群？" }))
    );

    expect(parsed.found).toBeTrue();
    expect(parsed.answer).toBe("点置顶那条链接");
  });

  test("原文对不上就如实说没有，绝不模糊匹配到别条", () => {
    const parsed: { found: boolean } = JSON.parse(
      executeGroupQaAnswer(ENTRIES, JSON.stringify({ question: "怎么入群" }))
    );

    expect(parsed.found).toBeFalse();
  });

  test("入参非法时返回工具错误而不是抛出", () => {
    expect(executeGroupQaAnswer(ENTRIES, "not json")).toContain("valid JSON");
    expect(executeGroupQaAnswer(ENTRIES, JSON.stringify({}))).toContain("non-empty question");
    expect(executeGroupQaAnswer(ENTRIES, JSON.stringify({ question: 1 })))
      .toContain("non-empty question");
  });

  test("没有问答表时 query 返回空清单而不是抛出", () => {
    expect(JSON.parse(executeGroupQaQuery(undefined))).toEqual({ questions: [] });
  });
});
