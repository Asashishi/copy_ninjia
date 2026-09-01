import type { Message, MessageEntity } from "grammy/types";
import { describe, expect, test } from "bun:test";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_QUESTION_MAX_CHARS,
  QA_COMMAND_TEXTS,
  QA_TRUNCATION_MARK,
} from "../../packages/consts/qa";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../packages/consts/telegram";
import {
  parseQaFieldMessage,
  renderQaFormPrompt,
} from "../../packages/commands/qa/rendering";
import type { QaFieldInput } from "../../packages/types/qa";

const JSON_BODY: string = '[\n  {\n    "称号": "天朝撞库王"\n  }\n]';

function groupMessage(text: string, entities?: readonly MessageEntity[]): Message {
  return {
    message_id: 7,
    date: 1,
    chat: { id: -1001, type: "supergroup", title: "T" },
    text,
    from: { id: 42, is_bot: false, first_name: "A" },
    ...(entities === undefined ? {} : { entities: [...entities] }),
  } as Message;
}

describe("表单字段解析", () => {
  test("半角与全角冒号都收", () => {
    expect(parseQaFieldMessage(groupMessage("问题: 怎么入群？")))
      .toEqual({ q: "怎么入群？", a: undefined });
    expect(parseQaFieldMessage(groupMessage("问题：怎么入群？")))
      .toEqual({ q: "怎么入群？", a: undefined });
    expect(parseQaFieldMessage(groupMessage("回答: 点置顶")))
      .toEqual({ q: undefined, a: "点置顶" });
    // 「答案」是本天才回执里的说法，照着抄同样认。
    expect(parseQaFieldMessage(groupMessage("答案：点置顶")))
      .toEqual({ q: undefined, a: "点置顶" });
  });

  test("标签独占一行、取值换行写在后面", () => {
    expect(parseQaFieldMessage(groupMessage("问题:\n怎么入群？\n还有呢")))
      .toEqual({ q: "怎么入群？\n还有呢", a: undefined });
  });

  test("两项写在同一条消息里也照收", () => {
    expect(parseQaFieldMessage(groupMessage("问题:\n怎么入群？\n回答:\n点置顶")))
      .toEqual({ q: "怎么入群？", a: "点置顶" });
  });

  test("答案里的 ```json 块还原成字面围栏存下来", () => {
    const text: string = `回答:\n${JSON_BODY}`;
    const parsed: QaFieldInput | undefined = parseQaFieldMessage(groupMessage(text, [
      { type: "pre", offset: 4, length: JSON_BODY.length, language: "json" },
    ]));

    expect(parsed?.a).toBe(`\`\`\`json\n${JSON_BODY}\n\`\`\``);
  });

  test("代码块内部以标签开头的行不切断答案", () => {
    // 块内正文自带一行「回答:」——认它就会把答案从中间劈开。
    const body: string = "回答: 这一行在代码块里\n第二行";
    const text: string = `回答:\n${body}`;
    const parsed: QaFieldInput | undefined = parseQaFieldMessage(groupMessage(text, [
      { type: "pre", offset: 4, length: body.length, language: "json" },
    ]));

    expect(parsed?.a).toBe(`\`\`\`json\n${body}\n\`\`\``);
    expect(parsed?.q).toBeUndefined();
  });

  test("标签只在行首生效", () => {
    expect(parseQaFieldMessage(groupMessage("前面有字问题: 怎么入群？"))).toBeUndefined();
    expect(parseQaFieldMessage(groupMessage("我想问题在哪"))).toBeUndefined();
  });

  test("同一字段写两次以先出现的为准", () => {
    expect(parseQaFieldMessage(groupMessage("问题:\n第一段\n问题:\n第二段")))
      .toEqual({ q: "第一段", a: undefined });
  });

  test("没有标签、取值为空、非文本消息一律不认领", () => {
    expect(parseQaFieldMessage(groupMessage("怎么入群？"))).toBeUndefined();
    expect(parseQaFieldMessage(groupMessage("问题:"))).toBeUndefined();
    expect(parseQaFieldMessage(groupMessage("问题:   \n  "))).toBeUndefined();
    expect(parseQaFieldMessage({
      message_id: 7,
      date: 1,
      chat: { id: -1001, type: "supergroup", title: "T" },
    } as Message)).toBeUndefined();
  });

  test("取值两端的空白被 trim 掉", () => {
    // 前后带空格的问题用户永远打不出来，留着会让直答永远命中不了。
    expect(parseQaFieldMessage(groupMessage("问题:   怎么入群？  "))?.q).toBe("怎么入群？");
  });
});

describe("表单提示", () => {
  test("提示里写着两个标签，未填项显示成未设置", () => {
    const prompt: string = renderQaFormPrompt(undefined, undefined);

    expect(prompt).toContain("问题:");
    expect(prompt).toContain("回答:");
    expect(prompt).toContain(QA_COMMAND_TEXTS.formUnset);
  });

  test("已收到的项照原样摆出来", () => {
    const prompt: string = renderQaFormPrompt("怎么入群？", undefined);

    expect(prompt).toContain("怎么入群？");
    expect(prompt).toContain(QA_COMMAND_TEXTS.formUnset);
  });

  test("两项都填满时按 Telegram 上限截断回答，问题不动", () => {
    // 两项上限各自独立（256 / 3840），且分别来自不同的投递消息——单条入站
    // 消息的 4096 上限管不住它们的和。不截断的话这里是 4216，editMessageText
    // 拿到 400 并被 editQaForm 丢弃，表单会一直停在旧内容上。
    const question: string = "问".repeat(CHAT_QA_QUESTION_MAX_CHARS);
    const answer: string = "答".repeat(CHAT_QA_ANSWER_MAX_CHARS);
    const prompt: string = renderQaFormPrompt(question, answer);

    expect(prompt.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
    expect(prompt).toContain(question);
    expect(prompt.endsWith(QA_TRUNCATION_MARK)).toBeTrue();
  });

  test("装得下时一个字都不截，也不补省略号", () => {
    const answer: string = "答".repeat(CHAT_QA_ANSWER_MAX_CHARS);
    const prompt: string = renderQaFormPrompt(undefined, answer);

    expect(prompt.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
    expect(prompt).toContain(answer);
    expect(prompt.endsWith(QA_TRUNCATION_MARK)).toBeFalse();
  });

  test("截断点不落在代理对中间", () => {
    // 预算刚好把一个星标切成两半时，truncateInline 必须退回整字符；留下孤立
    // 高位代理会在表单上显示成乱码方块。
    const question: string = "问".repeat(CHAT_QA_QUESTION_MAX_CHARS);
    for (let padding: number = 0; padding < 4; padding++) {
      const answer: string = "答".repeat(padding) + "🌟".repeat(CHAT_QA_ANSWER_MAX_CHARS);
      const prompt: string = renderQaFormPrompt(question, answer.slice(0, CHAT_QA_ANSWER_MAX_CHARS));

      expect(prompt.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      expect(prompt).not.toContain("�");
      expect([...prompt].every((char: string): boolean => char.codePointAt(0)! !== 0xfffd)).toBeTrue();
      const body: string = prompt.slice(0, -QA_TRUNCATION_MARK.length);
      const lastCode: number = body.charCodeAt(body.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBeFalse();
    }
  });
});
