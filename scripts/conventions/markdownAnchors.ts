import { withoutMarkdownCodeFences } from "./markdownSource";

/**
 * Markdown 本地链接里 `#片段` 的存在性核对。
 *
 * 从目标文档的标题与显式 HTML id 建立锚点集合，核对本地链接的片段，覆盖三语导航。
 */

/** 去掉标题里的行内 Markdown 装饰，只留渲染后的可见文本。 */
function headingText(raw: string): string {
  return raw
    // 行内代码、加粗、斜体与删除线只影响样式，不进锚点。
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    // 链接只保留可见文字。
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * GitHub 的标题锚点算法：转小写，丢掉除连字符、下划线与空白之外的标点，空白转
 * 连字符；同名标题按出现顺序追加 `-1`、`-2`。emoji 等符号按标点丢弃，因此
 * 「## 🚀 快速开始」得到的是 `-快速开始`。
 */
export function markdownAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  const counts: Map<string, number> = new Map<string, number>();
  for (const match of withoutMarkdownCodeFences(source).matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const slug: string = slugify(headingText(match[2] ?? ""));
    const seen: number = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    anchors.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  return anchors;
}

/** 把一段文本按 GitHub 的标题锚点规则压成 slug。 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * HTML 标题（`<h1>`…`<h6>`）同样会生成锚点，取的是去掉内嵌标签后的可见文字。
 * 三份 README 的主标题就是这种写法，「回到顶部」全指向它。
 */
export function markdownHtmlHeadingAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  for (const match of source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text: string = (match[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 0) anchors.add(slugify(text));
  }
  return anchors;
}

/**
 * HTML 显式锚点（`<a id="x">`、`<a name="x">`、任意元素的 `id="x"`）。
 * 文档里的徽章与折叠块会用到，它们同样是合法的跳转目标。
 */
export function markdownHtmlAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  for (const match of source.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
    const anchor: string | undefined = match[1];
    if (anchor !== undefined) anchors.add(anchor.toLowerCase());
  }
  return anchors;
}

/** 一份文档里全部可跳转的锚点。 */
export function collectMarkdownAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>(markdownAnchors(source));
  for (const anchor of markdownHtmlHeadingAnchors(source)) anchors.add(anchor);
  for (const anchor of markdownHtmlAnchors(source)) anchors.add(anchor);
  return anchors;
}
