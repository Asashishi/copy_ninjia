/**
 * Markdown 锚点解析（scripts/conventions/markdownAnchors.ts）。
 * 文档链接的 `#片段` 核对依赖它，口径必须与 GitHub 渲染一致。
 */

import { describe, expect, test } from "bun:test";
import {
  collectMarkdownAnchors,
  markdownAnchors,
  markdownHtmlAnchors,
  markdownHtmlHeadingAnchors,
} from "../../scripts/conventions/markdownAnchors";

describe("Markdown 标题锚点", () => {
  test("英文标题转小写、空白转连字符、标点丢弃", () => {
    expect([...markdownAnchors("# Startup and Import Boundaries\n")])
      .toEqual(["startup-and-import-boundaries"]);
    expect([...markdownAnchors("### `/wed` Member Persistence and Interaction\n")])
      .toEqual(["wed-member-persistence-and-interaction"]);
  });

  test("中日文标题原样保留，emoji 按标点丢弃", () => {
    expect([...markdownAnchors("## 可选凭据与严格配置预检\n")])
      .toEqual(["可选凭据与严格配置预检"]);
    expect([...markdownAnchors("### 任意の資格情報と設定の厳密な事前検証\n")])
      .toEqual(["任意の資格情報と設定の厳密な事前検証"]);
    expect([...markdownAnchors("## 🚀 快速开始\n")]).toEqual(["-快速开始"]);
  });

  test("同名标题按出现顺序追加序号", () => {
    expect([...markdownAnchors("## Notes\n## Notes\n## Notes\n")])
      .toEqual(["notes", "notes-1", "notes-2"]);
  });

  test("行内装饰与链接只取可见文字", () => {
    expect([...markdownAnchors("## **加粗** 与 [链接](x.md)\n")]).toEqual(["加粗-与-链接"]);
  });

  test("代码块里的井号不是标题", () => {
    expect([...markdownAnchors("```sh\n# not a heading\n```\n## real\n")]).toEqual(["real"]);
  });
});

describe("HTML 锚点", () => {
  test("HTML 标题按可见文字生成锚点", () => {
    expect([...markdownHtmlHeadingAnchors('<h1>\n  <a href="x"><img alt="y"></a>\n  Copy Ninjia\n</h1>')])
      .toEqual(["copy-ninjia"]);
  });

  test("显式 id / name 直接作为锚点", () => {
    expect([...markdownHtmlAnchors('<a id="Top"></a><div name="Bottom"></div>')])
      .toEqual(["top", "bottom"]);
  });

  test("三类锚点合并成同一份集合", () => {
    const anchors: ReadonlySet<string> = collectMarkdownAnchors(
      '<h1>Copy Ninjia</h1>\n<a id="top"></a>\n\n## 快速开始\n'
    );
    expect(anchors.has("copy-ninjia")).toBeTrue();
    expect(anchors.has("top")).toBeTrue();
    expect(anchors.has("快速开始")).toBeTrue();
  });
});
