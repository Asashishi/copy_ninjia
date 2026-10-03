import { describe, expect, test } from "bun:test";
import {
  escapeMarkdownV2,
  escapeMarkdownV2Code,
  escapeMarkdownV2Url,
  markdownV2Bold,
  markdownV2BoldItalic,
  markdownV2InlineCode,
  markdownV2Link,
  markdownV2Pre,
  markdownV2Quote,
} from "../../packages/libs/telegramMarkdown";
import { parseMarkdownV2 } from "../helpers/markdownV2";
import type { ParsedMarkdownV2 } from "../helpers/markdownV2";

/** Bot API 列出的 18 个正文保留字符。 */
const RESERVED: string = "_*[]()~`>#+-=|{}.!";

describe("libs/telegramMarkdown 转义", () => {
  test("正文：18 个保留字符与反斜杠逐个加反斜杠，解析回来与原文一致", () => {
    for (const character of `${RESERVED}\\`) {
      expect(escapeMarkdownV2(character)).toBe(`\\${character}`);
    }
    const hostile: string = `*粗* _斜_ [链](https://t.me/x) \`码\` >引 #1 a+b-c=d |x| {y} 结束. 喵! \\`;
    expect(parseMarkdownV2(escapeMarkdownV2(hostile))).toEqual({ text: hostile, entities: [] });
  });

  test("未转义的保留字符会被 Telegram 拒收：参照解析器同样抛错", () => {
    expect(() => parseMarkdownV2("1. 结束")).toThrow("reserved");
    expect(() => parseMarkdownV2("a-b")).toThrow("reserved");
  });

  test("emoji 与 CJK 原样保留，不额外加反斜杠", () => {
    const text: string = "本天才♡ 🐱 ねこ 猫";
    expect(escapeMarkdownV2(text)).toBe(text);
  });

  test("代码上下文只转义反引号与反斜杠，链接上下文只转义右括号与反斜杠", () => {
    expect(escapeMarkdownV2Code("a`b\\c*d_e.f")).toBe("a\\`b\\\\c*d_e.f");
    expect(escapeMarkdownV2Url("https://e.x/a_(b)\\c.d")).toBe("https://e.x/a_(b\\)\\\\c.d");
  });
});

describe("libs/telegramMarkdown 拼装", () => {
  test("粗体、粗斜体、链接、内联代码各自解析成一个恰好框住原文的实体", () => {
    const source: string = [
      markdownV2Bold("今日*新闻*"),
      markdownV2BoldItalic("A_I_"),
      markdownV2Link("[CNBC]", "https://e.x/a_(b)"),
      markdownV2InlineCode("-100`1"),
    ].join(" ");
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(source);

    expect(parsed.text).toBe("今日*新闻* A_I_ [CNBC] -100`1");
    expect(parsed.entities).toEqual([
      { type: "bold", offset: 0, length: 6 },
      { type: "italic", offset: 7, length: 4 },
      { type: "bold", offset: 7, length: 4 },
      { type: "text_link", offset: 12, length: 6, url: "https://e.x/a_(b)" },
      { type: "code", offset: 19, length: 6 },
    ]);
  });

  test("代码块：语言标注生效，块内正文与原文逐字相同，块后正文照常衔接", () => {
    const json: string = JSON.stringify({ "a.b": "`x`\\", list: [1, -2] }, null, 2);
    const source: string = `${escapeMarkdownV2("前缀：\n")}${markdownV2Pre(json, "json")}${escapeMarkdownV2("\n后缀.")}`;
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(source);

    expect(parsed.text).toBe(`前缀：\n${json}\n后缀.`);
    expect(parsed.entities).toEqual([
      { type: "pre", offset: 4, length: json.length, language: "json" },
    ]);
  });

  test("单行引用位于行首时整行成为引用块", () => {
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(`${escapeMarkdownV2("正文")}\n${markdownV2Quote("以原文为准 (仅供参考).")}`);
    expect(parsed.text).toBe("正文\n以原文为准 (仅供参考).");
    expect(parsed.entities).toEqual([{ type: "blockquote", offset: 3, length: 13 }]);
  });

  test("空内容一律抛错，多行引用不受理", () => {
    expect(() => markdownV2Bold("")).toThrow("must not be empty");
    expect(() => markdownV2BoldItalic("")).toThrow("must not be empty");
    expect(() => markdownV2Link("", "https://e.x")).toThrow("must not be empty");
    expect(() => markdownV2Link("x", "")).toThrow("must not be empty");
    expect(() => markdownV2InlineCode("")).toThrow("must not be empty");
    expect(() => markdownV2Pre("", "json")).toThrow("must not be empty");
    expect(() => markdownV2Pre("{}", "")).toThrow("must not be empty");
    expect(() => markdownV2Quote("")).toThrow("must not be empty");
    expect(() => markdownV2Quote("a\nb")).toThrow("single line");
  });
});
