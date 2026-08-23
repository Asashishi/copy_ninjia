import { describe, expect, test } from "bun:test";
import {
  buildGroupQaToolDefinitions,
  executeGroupQaAnswer,
  executeGroupQaQuery,
} from "../../packages/aiChat/ai/tools/replyToolset/groupQa";

const ENTRIES: ReadonlyMap<string, string> = new Map([
  ["怎么入群？", "点置顶那条链接"],
  ["几点开饭", "十一点半"],
]);

describe("群问答的两个模型工具", () => {
  test("本群没登记问答时两个工具都不挂", () => {
    expect(buildGroupQaToolDefinitions(undefined)).toHaveLength(0);
    expect(buildGroupQaToolDefinitions(new Map())).toHaveLength(0);
  });

  test("有问答时挂两个纯查询工具，且都不占动作预算", async () => {
    const definitions = buildGroupQaToolDefinitions(ENTRIES);
    expect(definitions.map((d) => d.name)).toEqual(["group_qa_query", "group_qa_answer"]);
    // 动作预算清单是另一份常量；这两个不在其中，因此模型可以随便查而不消耗回合。
    const { ACTION_TOOL_NAMES } = await import("../../packages/consts/tools");
    for (const definition of definitions) {
      expect(ACTION_TOOL_NAMES).not.toContain(definition.name);
    }
  });

  test("query 只给问题清单，不泄漏答案", () => {
    const parsed: { questions: string[] } = JSON.parse(executeGroupQaQuery(ENTRIES));

    expect(parsed.questions).toEqual(["怎么入群？", "几点开饭"]);
    // 清单里不能带答案：先让模型判断语义够不够近，够近才去取答案。
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

    // 模型改写了原文时替它猜一条最像的，等于把本群没登记过的答案说成登记过的。
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
