import { describe, expect, test } from "bun:test";
import {
  QA_INLINE_ANSWER_LABEL,
  QA_INLINE_QUESTION_LABEL,
} from "../../packages/consts/qa";
import {
  formatQaJsonMessage,
  parseQaInlineResult,
  renderQaInlineResult,
} from "../../packages/commands/qa/rendering";
import type { QaJsonMessage } from "../../packages/commands/qa/rendering";

describe("群问答渲染", () => {
  test("单条按规格里那个对象形状返回", () => {
    const rendered: QaJsonMessage = formatQaJsonMessage([{ q: "怎么入群？", a: "点置顶" }]);
    const entity = rendered.entities[0]!;
    const json: string = rendered.text.slice(entity.offset, entity.offset + entity.length);

    expect(JSON.parse(json)).toEqual({ q: "怎么入群？", a: "点置顶" });
    expect(entity).toMatchObject({ type: "pre", language: "json" });
  });

  test("多条返回数组", () => {
    const rendered: QaJsonMessage = formatQaJsonMessage([
      { q: "a", a: "1" },
      { q: "b", a: "2" },
    ]);
    const entity = rendered.entities[0]!;

    expect(JSON.parse(rendered.text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual([{ q: "a", a: "1" }, { q: "b", a: "2" }]);
  });

  test("代码块实体的 offset/length 按 UTF-16 code unit 精确覆盖 JSON", () => {
    // 写死成别的长度不会报错，只会让 Telegram 把代码块画歪或整段吞掉。
    const rendered: QaJsonMessage = formatQaJsonMessage([{ q: "问题♡", a: "答案𝄞" }]);
    const entity = rendered.entities[0]!;

    expect(entity.offset + entity.length).toBe(rendered.text.length);
    expect(() => JSON.parse(
      rendered.text.slice(entity.offset, entity.offset + entity.length)
    )).not.toThrow();
  });

  test("inline 结果的渲染与解析是一对可逆操作", () => {
    for (const field of ["q", "a"] as const) {
      const text: string = renderQaInlineResult(field, "怎么入群？");
      expect(parseQaInlineResult(text)).toEqual({ field, value: "怎么入群？" });
    }
    expect(renderQaInlineResult("q", "x").startsWith(QA_INLINE_QUESTION_LABEL)).toBeTrue();
    expect(renderQaInlineResult("a", "x").startsWith(QA_INLINE_ANSWER_LABEL)).toBeTrue();
  });

  test("没有本领域标签的正文一律不认领", () => {
    expect(parseQaInlineResult("怎么入群？")).toBeUndefined();
    expect(parseQaInlineResult("（透过键盘）说点什么")).toBeUndefined();
    expect(parseQaInlineResult("")).toBeUndefined();
  });

  test("正文里含标签但不在开头同样不认领", () => {
    expect(parseQaInlineResult(`前面有字${QA_INLINE_QUESTION_LABEL}怎么入群？`))
      .toBeUndefined();
  });
});
