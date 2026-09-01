import type { MessageEntity } from "grammy/types";
import { describe, expect, test } from "bun:test";
import { captureFencedText, renderFencedText } from "../../packages/libs/codeFence";
import type { RichTextMessage } from "../../packages/types/telegram";

/** Telegram 发来的一整块 ```json：正文里没有围栏，只有一条 pre 实体。 */
const JSON_BODY: string = '[\n  {\n    "称号": "天朝撞库王"\n  }\n]';

describe("captureFencedText", () => {
  test("没有实体时就是一次普通切片", () => {
    expect(captureFencedText({
      text: "问题:怎么入群？",
      entities: undefined,
      start: 3,
      end: 8,
    })).toBe("怎么入群？");
  });

  test("pre 实体还原成带语言标记的字面围栏", () => {
    const text: string = `回答:\n${JSON_BODY}`;
    const entities: readonly MessageEntity[] = [
      { type: "pre", offset: 4, length: JSON_BODY.length, language: "json" },
    ];

    expect(captureFencedText({ text, entities, start: 3, end: text.length }))
      .toBe(`\n\`\`\`json\n${JSON_BODY}\n\`\`\``);
  });

  test("没有语言的代码块还原成裸围栏", () => {
    const text: string = "回答:abc";
    const entities: readonly MessageEntity[] = [{ type: "pre", offset: 3, length: 3 }];

    expect(captureFencedText({ text, entities, start: 3, end: text.length }))
      .toBe("```\nabc\n```");
  });

  test("读不回的语言标记被丢弃，退化成裸围栏而不是坏掉的开栏", () => {
    // 带空白的语言标记若原样写进围栏，渲染侧就不再认它是开栏，
    // 那条答案会连着可见的反引号一起发出去。
    const text: string = "回答:abc";
    const entities: readonly MessageEntity[] = [
      { type: "pre", offset: 3, length: 3, language: "json 篡改" },
    ];

    const stored: string = captureFencedText({ text, entities, start: 3, end: text.length });

    expect(stored).toBe("```\nabc\n```");
    // 关键断言：存下去的东西必须还能被渲染侧读回成代码块。
    expect(renderFencedText(stored).entities[0]).toMatchObject({ type: "pre", offset: 0, length: 3 });
  });

  test("越过取值区间的实体按普通文本取出，不造半截围栏", () => {
    const text: string = "问题:abc回答:def";
    // pre 实体横跨两个字段：认它就会在问题里留下一个没有闭栏的开栏。
    const entities: readonly MessageEntity[] = [{ type: "pre", offset: 3, length: 9 }];

    expect(captureFencedText({ text, entities, start: 3, end: 6 })).toBe("abc");
  });

  test("非 pre 实体不影响取值", () => {
    const text: string = "回答:粗体";
    const entities: readonly MessageEntity[] = [{ type: "bold", offset: 3, length: 2 }];

    expect(captureFencedText({ text, entities, start: 3, end: text.length })).toBe("粗体");
  });
});

describe("renderFencedText", () => {
  test("没有围栏的文本原样返回，且不分配新实体表", () => {
    const answer: string = "点置顶那条♡";
    const rendered: RichTextMessage = renderFencedText(answer);

    expect(rendered.text).toBe(answer);
    expect(rendered.entities).toHaveLength(0);
  });

  test("字面围栏拆成正文加 pre 实体，偏移精确覆盖块内正文", () => {
    const rendered: RichTextMessage = renderFencedText(
      `前言\n\`\`\`json\n${JSON_BODY}\n\`\`\`\n后记`
    );
    const entity: MessageEntity | undefined = rendered.entities[0];

    expect(entity).toMatchObject({ type: "pre", language: "json" });
    expect(rendered.text).toBe(`前言\n${JSON_BODY}\n后记`);
    expect(rendered.text.slice(entity!.offset, entity!.offset + entity!.length))
      .toBe(JSON_BODY);
  });

  test("整条消息只有一个代码块时实体覆盖全文", () => {
    const rendered: RichTextMessage = renderFencedText(`\`\`\`json\n${JSON_BODY}\n\`\`\``);
    const entity: MessageEntity | undefined = rendered.entities[0];

    expect(rendered.text).toBe(JSON_BODY);
    expect(entity!.offset).toBe(0);
    expect(entity!.length).toBe(rendered.text.length);
  });

  test("未闭合的开栏按普通文本保留，不吞掉后面的正文", () => {
    const rendered: RichTextMessage = renderFencedText("```json\n还没写完");

    expect(rendered.text).toBe("```json\n还没写完");
    expect(rendered.entities).toHaveLength(0);
  });

  test("空代码块整组丢弃——Telegram 拒收零长度实体", () => {
    const rendered: RichTextMessage = renderFencedText("前\n```json\n```\n后");

    expect(rendered.entities).toHaveLength(0);
    expect(rendered.text).toBe("前\n后");
  });

  test("拆完为空时整段退回原文，不产出发不出去的空消息", () => {
    // 只有一个空代码块：丢弃它会得到空正文，而 Telegram 拒收空正文——
    // 那条问答就成了「存得进库却永远答不出来」的死条目。
    const rendered: RichTextMessage = renderFencedText("```json\n```");

    expect(rendered.text).toBe("```json\n```");
    expect(rendered.entities).toHaveLength(0);
  });

  test("多个代码块各自成一条实体", () => {
    const rendered: RichTextMessage = renderFencedText("```json\na\n```\n中间\n```ts\nb\n```");

    expect(rendered.entities).toHaveLength(2);
    expect(rendered.text).toBe("a\n中间\nb");
    for (const entity of rendered.entities) {
      expect(rendered.text.slice(entity.offset, entity.offset + entity.length).length)
        .toBe(entity.length);
    }
    expect(rendered.entities[1]).toMatchObject({ language: "ts" });
  });
});

describe("两个方向是一对可逆操作", () => {
  test("Telegram 正文 -> 落盘围栏 -> 再发出去，块内正文一字不差", () => {
    const incoming: string = `回答:\n${JSON_BODY}`;
    const stored: string = captureFencedText({
      text: incoming,
      entities: [{ type: "pre", offset: 4, length: JSON_BODY.length, language: "json" }],
      start: 3,
      end: incoming.length,
    }).trim();
    const rendered: RichTextMessage = renderFencedText(stored);
    const entity: MessageEntity | undefined = rendered.entities[0];

    expect(rendered.text.slice(entity!.offset, entity!.offset + entity!.length))
      .toBe(JSON_BODY);
    expect(entity).toMatchObject({ type: "pre", language: "json" });
  });
});
