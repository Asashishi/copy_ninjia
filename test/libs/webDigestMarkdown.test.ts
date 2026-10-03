import { describe, expect, test } from "bun:test";
import { renderWebDigestMarkdown } from "../../packages/libs/webDigestMarkdown";
import { WEB_DIGEST_SOURCE_LABELS, WEB_DIGEST_TIME_SEPARATOR } from "../../packages/consts/webDigest";
import { parseMarkdownV2 } from "../helpers/markdownV2";
import type { ParsedMarkdownV2 } from "../helpers/markdownV2";
import type { RenderedWebDigest, WebDigest, WebDigestLanguage } from "../../packages/types/webDigest";

const DIGEST: WebDigest = {
  title: "今日科技新闻",
  summary: "国内外 AI 动态速览。",
  sections: [
    {
      heading: "AI",
      items: [
        { title: "谷歌发布 Gemini 4", body: "谷歌发布了新一代模型。", source: "CNBC", url: "https://www.cnbc.com/a_(b)", time: "10-01" },
        { title: "第二条", body: "正文二。", source: "Reuters", url: "https://r.example/2", time: undefined },
      ],
    },
    {
      heading: "芯片",
      items: [{ title: "第三条", body: "正文三。", source: "日经", url: "https://n.example/3", time: undefined }],
    },
  ],
  closing: "以上内容由检索整理，以原文为准。",
};

describe("libs/webDigestMarkdown renderWebDigestMarkdown", () => {
  test("按规则渲染，Telegram 解析后的可见正文与实体都符合预期，编号跨小节连续", () => {
    const rendered: RenderedWebDigest = renderWebDigestMarkdown(DIGEST, "zh");
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(rendered.text);
    const label: string = WEB_DIGEST_SOURCE_LABELS.zh;

    expect(parsed.text).toBe(
      "今日科技新闻\n\n国内外 AI 动态速览。\n\nAI\n\n" +
      `1. 谷歌发布 Gemini 4\n谷歌发布了新一代模型。\n${label}CNBC${WEB_DIGEST_TIME_SEPARATOR}10-01\n\n` +
      `2. 第二条\n正文二。\n${label}Reuters\n\n芯片\n\n` +
      `3. 第三条\n正文三。\n${label}日经\n\n以上内容由检索整理，以原文为准。`
    );
    expect(rendered.visibleLength).toBe(parsed.text.length);
    const links = parsed.entities.filter((entity) => entity.type === "text_link");
    expect(links.map((entity) => entity.url)).toEqual(["https://www.cnbc.com/a_(b)", "https://r.example/2", "https://n.example/3"]);
    expect(parsed.entities.filter((entity) => entity.type === "blockquote")).toHaveLength(1);
    expect(parsed.entities.filter((entity) => entity.type === "italic").map((entity) => parsed.text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual(["AI", "芯片"]);
  });

  test("三种语言各用自己的来源标签", () => {
    for (const language of ["zh", "ja", "en"] as readonly WebDigestLanguage[]) {
      expect(parseMarkdownV2(renderWebDigestMarkdown(DIGEST, language).text).text)
        .toContain(`${WEB_DIGEST_SOURCE_LABELS[language]}CNBC`);
    }
  });

  test("条目正文的平台换行原样保留，来源另起一行", () => {
    const digest: WebDigest = {
      title: "今日动漫",
      summary: undefined,
      sections: [{ heading: "更新", items: [{
        title: "作品名",
        body: "Netflix 第3集 · 00:00 JST（预计）\nU-NEXT 第3集 · 时间待确认（预计）",
        source: "官方",
        url: "https://a.example",
        time: undefined,
      }] }],
      closing: undefined,
    };
    const rendered: RenderedWebDigest = renderWebDigestMarkdown(digest, "zh");
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(rendered.text);
    expect(parsed.text).toContain(`作品名\nNetflix 第3集 · 00:00 JST（预计）\nU-NEXT 第3集 · 时间待确认（预计）\n${WEB_DIGEST_SOURCE_LABELS.zh}官方`);
    expect(rendered.visibleLength).toBe(parsed.text.length);
  });

  test("可选的导语、时间与结语缺省时整段不出现", () => {
    const minimal: WebDigest = {
      title: "T",
      summary: undefined,
      sections: [{ heading: "H", items: [{ title: "I", body: "B", source: "S", url: "https://s.example", time: undefined }] }],
      closing: undefined,
    };
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(renderWebDigestMarkdown(minimal, "en").text);
    expect(parsed.text).toBe(`T\n\nH\n\n1. I\nB\n${WEB_DIGEST_SOURCE_LABELS.en}S`);
    expect(parsed.entities.some((entity) => entity.type === "blockquote")).toBeFalse();
  });

  test("对抗性模型文本只按字面显示：保留字符、伪造链接、反引号都不形成格式", () => {
    const hostile: string = "*粗*_斜_[假](https://evil.example)`码`>引 #1 a+b-c=d |x| {y}. !\\";
    const rendered: RenderedWebDigest = renderWebDigestMarkdown({
      title: hostile,
      summary: hostile,
      sections: [{ heading: hostile, items: [{ title: hostile, body: hostile, source: hostile, url: "https://s.example/)", time: hostile }] }],
      closing: hostile,
    }, "zh");
    const parsed: ParsedMarkdownV2 = parseMarkdownV2(rendered.text);
    // 标题、导语、小节、条目标题、正文、来源名、时间、结语共 8 处，全部原样出现。
    expect(parsed.text.split(hostile).length - 1).toBe(8);
    expect(parsed.entities.filter((entity) => entity.type === "text_link").map((entity) => entity.url)).toEqual(["https://s.example/)"]);
    expect(rendered.visibleLength).toBe(parsed.text.length);
  });

  test("可见长度按 UTF-16 计，emoji 占 2、CJK 占 1，与转义后的原文长度无关", () => {
    const rendered: RenderedWebDigest = renderWebDigestMarkdown({
      title: "😀.",
      summary: undefined,
      sections: [{ heading: "猫", items: [{ title: "-", body: "!", source: "s", url: "https://s.example", time: undefined }] }],
      closing: undefined,
    }, "en");
    expect(rendered.visibleLength).toBe(parseMarkdownV2(rendered.text).text.length);
    expect(rendered.text.length).toBeGreaterThan(rendered.visibleLength);
  });
});
