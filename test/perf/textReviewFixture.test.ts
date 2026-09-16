import { describe, expect, test } from "bun:test";
import { INLINE_SANITIZE_REQUIRED_PATTERN } from "../../packages/consts/text";
import { buildBufferedMessage } from "../../packages/workers/aiChat/bufferedMessage";
import {
  findTextReviewScenario,
  TEXT_REVIEW_SCENARIOS,
  textReviewInputs,
  textReviewIterations,
} from "../../scripts/perf/review/textFixture";
import type { TextReviewInput, TextReviewScenario } from "../../scripts/perf/review/textFixture";

describe("文本清洗专项夹具", () => {
  test("场景名唯一，未知名称拒绝", () => {
    const names: readonly string[] = TEXT_REVIEW_SCENARIOS.map((scenario: TextReviewScenario): string => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect(findTextReviewScenario("message-1024").length).toBe(1_024);
    expect(() => findTextReviewScenario("missing")).toThrow("Unknown text review scenario: missing");
    expect(() => findTextReviewScenario(undefined)).toThrow("(missing)");
  });

  test.each(TEXT_REVIEW_SCENARIOS.map((scenario: TextReviewScenario): [string] => [scenario.name]))(
    "%s：长度、排版与迭代次数符合声明，消息场景全部可构造",
    (name: string) => {
      const scenario: TextReviewScenario = findTextReviewScenario(name);
      const inputs: readonly TextReviewInput[] = textReviewInputs(scenario);
      expect(inputs).toHaveLength(scenario.longPercent === null ? 100 : 1_000);
      const problems: string[] = [];
      let long: number = 0;
      for (const [index, input] of inputs.entries()) {
        const isLong: boolean = input.text.length === scenario.length;
        if (isLong) long++;
        else if (input.text.length !== 16) problems.push(`${index}: length ${input.text.length}`);
        if ((!isLong || scenario.layout === "canonical") && INLINE_SANITIZE_REQUIRED_PATTERN.test(input.text)) {
          problems.push(`${index}: not canonical`);
        }
        if (scenario.kind === "message" && buildBufferedMessage(input.source, input.text, 0) === null) {
          problems.push(`${index}: discarded`);
        }
        if ((input.source.replyTo !== undefined) !== scenario.reply) problems.push(`${index}: reply mismatch`);
      }
      expect(problems).toEqual([]);
      expect(long).toBe(scenario.longPercent === null ? inputs.length : scenario.longPercent * 10);
      const iterations: number = textReviewIterations(scenario, inputs);
      expect(Number.isSafeInteger(iterations) && iterations >= 4_000).toBeTrue();
      expect(scenario.longPercent === null || iterations % inputs.length === 0).toBeTrue();
    }
  );

  test("单处换行排版把换行放在首、中、尾，密集排版含多处换行与制表符", () => {
    const first = (name: string): string => textReviewInputs(findTextReviewScenario(name))[0]!.text;
    expect(first("message-1024-head").indexOf("\n")).toBe(1);
    expect(first("message-1024-middle").indexOf("\n")).toBe(512);
    expect(first("message-1024-tail").indexOf("\n")).toBe(1_022);
    for (const name of ["message-1024-head", "message-1024-middle", "message-1024-tail"]) {
      expect(first(name).split("\n")).toHaveLength(2);
    }
    const dense: string = first("message-1024-dense");
    expect(dense.split("\n").length).toBeGreaterThan(20);
    expect(dense.includes("\t")).toBeTrue();
  });

  test("混合语言按每十条六中三英一 emoji 轮换", () => {
    const inputs: readonly TextReviewInput[] = textReviewInputs(findTextReviewScenario("message-128"));
    const kinds: string[] = inputs.slice(0, 10).map((input: TextReviewInput): string =>
      /\p{Extended_Pictographic}/u.test(input.text) ? "emoji" : /\p{Script=Han}/u.test(input.text) ? "cjk" : "latin"
    );
    expect(kinds).toEqual(["cjk", "cjk", "cjk", "cjk", "cjk", "cjk", "latin", "latin", "latin", "emoji"]);
  });
});
