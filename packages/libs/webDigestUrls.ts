import {
  WEB_DIGEST_RESEARCH_URL_PATTERN,
  WEB_DIGEST_RESEARCH_URL_TRAILING_PUNCTUATION_PATTERN,
  WEB_DIGEST_URL_MAX_CHARS,
} from "../consts/webDigest";
import type { AiWebSearchResult } from "../types/aiChat/provider";

/** 检索段交回的正文与来源元数据。 */
export type WebDigestResearch = Pick<Extract<AiWebSearchResult, { readonly ok: true }>, "text" | "sources">;

/** 括号、方括号或花括号任一先出现不配对的闭合时，截到该闭合字符之前。 */
function truncateAtUnbalancedClosing(url: string): string {
  let parentheses: number = 0;
  let brackets: number = 0;
  let braces: number = 0;
  for (let index: number = 0; index < url.length; index++) {
    const character: string = url[index]!;
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "{") braces++;
    else if (character === "}") braces--;
    if (parentheses < 0 || brackets < 0 || braces < 0) return url.slice(0, index);
  }
  return url;
}

/**
 * 按 {@link researchSourceUrls} 的截取规则清理正文里匹配到的一条链接；超长、非 https 或带凭据时
 * 返回 `undefined`。`preceding` 是匹配起点前一个字符。
 */
function cleanResearchUrl(matched: string, preceding: string | undefined): string | undefined {
  let url: string = matched;
  if (preceding === "'") {
    const quoteEnd: number = url.indexOf("'");
    if (quoteEnd >= 0) url = url.slice(0, quoteEnd);
  }
  url = truncateAtUnbalancedClosing(url);
  if (preceding !== "(" && preceding !== "<" && preceding !== '"' && preceding !== "'" && preceding !== "`") {
    url = url.replace(WEB_DIGEST_RESEARCH_URL_TRAILING_PUNCTUATION_PATTERN, "");
  }
  if (url.length > WEB_DIGEST_URL_MAX_CHARS) return undefined;
  const parsed: URL | null = URL.parse(url);
  if (parsed?.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) return undefined;
  return url;
}

/**
 * 组稿条目地址的白名单：保留全部供应商来源地址，并补上正文中的合法 HTTPS 链接；不把链接视作
 * 搜索计数。正文链接按以下规则截取：紧跟单引号的链接截到下一个单引号；括号、方括号或花括号
 * 先闭合不配对处截断；没有被括号、尖括号、引号或反引号包围的裸链接去掉末尾英文句读；超长、
 * 非 https 或带凭据的链接丢弃。
 */
export function researchSourceUrls(research: WebDigestResearch): ReadonlySet<string> {
  const urls: Set<string> = new Set<string>();
  for (const source of research.sources) urls.add(source.url);
  for (const match of research.text.matchAll(WEB_DIGEST_RESEARCH_URL_PATTERN)) {
    const url: string | undefined = cleanResearchUrl(match[0], research.text[match.index - 1]);
    if (url !== undefined) urls.add(url);
  }
  return urls;
}
