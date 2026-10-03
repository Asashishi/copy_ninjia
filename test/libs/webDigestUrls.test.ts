import { describe, expect, test } from "bun:test";
import { WEB_DIGEST_URL_MAX_CHARS } from "../../packages/consts/webDigest";
import { researchSourceUrls } from "../../packages/libs/webDigestUrls";
import type { WebDigestResearch } from "../../packages/libs/webDigestUrls";

/** 检索正文链接与来源元数据合成的组稿地址白名单（libs/webDigestUrls.ts）。 */

function urls(text: string, sources: WebDigestResearch["sources"] = []): readonly string[] {
  return [...researchSourceUrls({ text, sources })];
}

describe("researchSourceUrls", () => {
  test("来源元数据地址原样保留，正文链接按出现顺序补上并去重", () => {
    expect(urls("见 https://b.example/2 与 https://b.example/2", [
      { title: "甲", url: "https://a.example/1" },
      { title: "乙", url: "http://legacy.example/" },
    ])).toEqual(["https://a.example/1", "http://legacy.example/", "https://b.example/2"]);
  });

  test("括号配平：链接自身成对的括号保留，先闭合不配对的括号处截断", () => {
    expect(urls("词条 https://en.wikipedia.org/wiki/Foo_(bar) 很长")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(urls("(参见 https://a.example/x) 后文")).toEqual(["https://a.example/x"]);
    expect(urls("[链接](https://a.example/y)")).toEqual(["https://a.example/y"]);
    expect(urls("{https://a.example/z}")).toEqual(["https://a.example/z"]);
    expect(urls("https://a.example/q[1]")).toEqual(["https://a.example/q[1]"]);
  });

  test("单引号开头的链接截到下一个单引号，不去句读", () => {
    expect(urls("'https://a.example/quoted'.")).toEqual(["https://a.example/quoted"]);
    expect(urls("'https://a.example/end.")).toEqual(["https://a.example/end."]);
  });

  test("裸链接去掉末尾英文句读；被括号、尖括号、引号或反引号包围时保留", () => {
    expect(urls("看 https://a.example/p. 和 https://a.example/q?!")).toEqual(["https://a.example/p", "https://a.example/q"]);
    expect(urls("(https://a.example/r.)")).toEqual(["https://a.example/r."]);
    expect(urls("<https://a.example/s.>")).toEqual(["https://a.example/s."]);
    expect(urls("`https://a.example/t.`")).toEqual(["https://a.example/t."]);
    expect(urls("https://a.example/u，中文句读不进链接。")).toEqual(["https://a.example/u"]);
  });

  test("非 https、带凭据或超长的正文链接丢弃", () => {
    expect(urls("http://a.example/plain https://user:pass@a.example/secret https://a.example/ok")).toEqual(["https://a.example/ok"]);
    const long: string = `https://a.example/${"x".repeat(WEB_DIGEST_URL_MAX_CHARS)}`;
    expect(urls(`${long} https://a.example/short`)).toEqual(["https://a.example/short"]);
  });
});
