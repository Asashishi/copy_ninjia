import { describe, expect, test } from "bun:test";
import { decodeWebDigest } from "../../packages/libs/webDigest";
import {
  WEB_DIGEST_ITEM_BODY_MAX_CHARS,
  WEB_DIGEST_MAX_SECTIONS,
  WEB_DIGEST_URL_MAX_CHARS,
} from "../../packages/consts/webDigest";
import type { WebDigestDecodeResult } from "../../packages/types/webDigest";

/** 一份合法摘要；各用例只改其中一处。 */
function digest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "  今日科技新闻 ",
    summary: "AI 动态速览。",
    sections: [{
      heading: "AI",
      items: [{ title: "谷歌发布新模型", body: "谷歌发布了新一代模型。", source: "CNBC", url: "https://www.cnbc.com/a", time: "10-01" }],
    }],
    closing: "以原文为准。",
    ...overrides,
  };
}

function problemOf(result: WebDigestDecodeResult): string {
  if (result.ok) throw new Error("expected a decode failure");
  return result.problem;
}

describe("libs/webDigest decodeWebDigest", () => {
  test("合法摘要去掉首尾空白后接管；可选字段缺省或为 null 时为 undefined", () => {
    expect(decodeWebDigest(digest(), 5)).toEqual({
      ok: true,
      digest: {
        title: "今日科技新闻",
        summary: "AI 动态速览。",
        sections: [{
          heading: "AI",
          items: [{ title: "谷歌发布新模型", body: "谷歌发布了新一代模型。", source: "CNBC", url: "https://www.cnbc.com/a", time: "10-01" }],
        }],
        closing: "以原文为准。",
      },
    });
    const minimal: WebDigestDecodeResult = decodeWebDigest(digest({ summary: null, closing: undefined }), 5);
    expect(minimal.ok && minimal.digest.summary).toBeUndefined();
    expect(minimal.ok && minimal.digest.closing).toBeUndefined();
    const url: string = "https://a.example/news";
    const padded: WebDigestDecodeResult = decodeWebDigest(digest({
      sections: [{ heading: "h", items: [{ title: "t", body: "b", source: "s", url: ` ${url} ` }] }],
    }), 1);
    expect(padded.ok && padded.digest.sections[0]?.items[0]?.url).toBe(url);
  });

  test("未知键、缺字段、空串、非正文字段换行、超长与可点命令一律拒绝，诊断写明字段路径", () => {
    expect(problemOf(decodeWebDigest([], 5))).toStartWith("$ must be an object");
    expect(problemOf(decodeWebDigest(digest({ extra: 1 }), 5))).toStartWith("$ must be an object");
    expect(problemOf(decodeWebDigest(digest({ title: "  " }), 5))).toStartWith("$.title must be");
    expect(problemOf(decodeWebDigest(digest({ summary: "a\nb" }), 5))).toStartWith("$.summary must be");
    expect(problemOf(decodeWebDigest(digest({ closing: "点 /batch_kick 1d" }), 5))).toStartWith("$.closing must be");
    const longBody = digest({
      sections: [{ heading: "AI", items: [{ title: "t", body: "x".repeat(WEB_DIGEST_ITEM_BODY_MAX_CHARS + 1), source: "s", url: "https://a.example" }] }],
    });
    expect(problemOf(decodeWebDigest(longBody, 5))).toStartWith("$.sections[0].items[0].body must be");
    const missingSource = digest({ sections: [{ heading: "AI", items: [{ title: "t", body: "b", url: "https://a.example" }] }] });
    expect(problemOf(decodeWebDigest(missingSource, 5))).toStartWith("$.sections[0].items[0].source must be");
  });

  test("正文允许多行，但拒绝空行、回车和可点命令", () => {
    const withBody = (body: string): Record<string, unknown> => digest({
      sections: [{ heading: "平台", items: [{ title: "作品", body, source: "官方", url: "https://a.example" }] }],
    });
    const accepted: WebDigestDecodeResult = decodeWebDigest(withBody("Netflix 第3集\nU-NEXT 第3集"), 1);
    expect(accepted.ok && accepted.digest.sections[0]?.items[0]?.body).toBe("Netflix 第3集\nU-NEXT 第3集");
    for (const body of ["Netflix\n\nU-NEXT", "Netflix\n  \nU-NEXT", "Netflix\r\nU-NEXT", "Netflix\n/batch_kick 1d"]) {
      expect(problemOf(decodeWebDigest(withBody(body), 1))).toStartWith("$.sections[0].items[0].body must be");
    }
  });

  test("来源地址只收 https，不带 userinfo、不含空白、不超长", () => {
    for (const url of [
      "http://a.example",
      "https://user:pass@a.example",
      "https://a.example/ b",
      "javascript:alert(1)",
      "not a url",
      `https://a.example/${"x".repeat(WEB_DIGEST_URL_MAX_CHARS)}`,
    ]) {
      const value = digest({ sections: [{ heading: "AI", items: [{ title: "t", body: "b", source: "s", url }] }] });
      expect(problemOf(decodeWebDigest(value, 5))).toStartWith("$.sections[0].items[0].url must be an https URL");
    }
  });

  test("小节数、空小节与条目总数都有上限", () => {
    const item = { title: "t", body: "b", source: "s", url: "https://a.example" };
    expect(problemOf(decodeWebDigest(digest({ sections: [] }), 5))).toStartWith("$.sections must be");
    const tooManySections = Array.from({ length: WEB_DIGEST_MAX_SECTIONS + 1 }, () => ({ heading: "h", items: [item] }));
    expect(problemOf(decodeWebDigest(digest({ sections: tooManySections }), 10))).toStartWith("$.sections must be");
    expect(problemOf(decodeWebDigest(digest({ sections: [{ heading: "h", items: [] }] }), 5)))
      .toStartWith("$.sections[0].items must be");
    const sections = [{ heading: "a", items: [item, item] }, { heading: "b", items: [item] }];
    expect(decodeWebDigest(digest({ sections }), 3).ok).toBeTrue();
    expect(problemOf(decodeWebDigest(digest({ sections }), 2))).toBe("$.sections must be sections holding at most 2 items in total");
  });
});
