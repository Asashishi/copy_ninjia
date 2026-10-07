/**
 * cron `send_web_digest` 的 JSON → Telegram MarkdownV2 渲染（纯函数，内存中合成，不落盘）。
 *
 * 规则（项目自定）：
 * - 首行 `*标题*`；有导语时空一行写导语；
 * - 每个小节空一行写 `*_小节名_*`，再空一行逐条写条目，条目之间空一行；
 * - 条目按全局连续编号写 `1\. *条目标题*`，下一行是正文，再下一行是
 *   「来源标签[来源名](地址)」，正文内部的换行原样保留；有时间时接 ` · 时间`；来源标签按摘要语言取
 *   WEB_DIGEST_SOURCE_LABELS；
 * - 有结语时空一行写单行引用 `>结语`。
 *
 * 所有文字都经 libs/telegramMarkdown.ts 转义，模型文本里的 `*`、`_`、`[x](…)` 只按字面显示。
 * 同一遍里累计 Telegram 解析后的可见正文，交回它的 UTF-16 长度供调用方核对 TELEGRAM_MESSAGE_MAX_CHARS。
 */

import { WEB_DIGEST_SOURCE_LABELS, WEB_DIGEST_TIME_SEPARATOR } from "../consts/webDigest";
import {
  escapeMarkdownV2,
  markdownV2Bold,
  markdownV2BoldItalic,
  markdownV2Link,
  markdownV2Quote,
} from "./telegramMarkdown";
import type { RenderedWebDigest, WebDigest, WebDigestLanguage } from "../types/webDigest";

/** 渲染一份已解码的摘要。 */
export function renderWebDigestMarkdown(
  digest: Readonly<WebDigest>,
  language: WebDigestLanguage
): RenderedWebDigest {
  let text: string = "";
  let visible: string = "";
  /** 追加一段：原文与它解析后的可见文字。 */
  function append(markdown: string, plain: string): void {
    text += markdown;
    visible += plain;
  }
  /** 追加一段不带格式的文字。 */
  function appendPlain(plain: string): void {
    append(escapeMarkdownV2(plain), plain);
  }

  append(markdownV2Bold(digest.title), digest.title);
  if (digest.summary !== undefined) appendPlain(`\n\n${digest.summary}`);
  const sourceLabel: string = WEB_DIGEST_SOURCE_LABELS[language];
  let number: number = 0;
  for (const section of digest.sections) {
    appendPlain("\n\n");
    append(markdownV2BoldItalic(section.heading), section.heading);
    for (const item of section.items) {
      number++;
      appendPlain(`\n\n${number}. `);
      append(markdownV2Bold(item.title), item.title);
      appendPlain(`\n${item.body}\n${sourceLabel}`);
      append(markdownV2Link(item.source, item.url), item.source);
      if (item.time !== undefined) appendPlain(`${WEB_DIGEST_TIME_SEPARATOR}${item.time}`);
    }
  }
  if (digest.closing !== undefined) {
    appendPlain("\n\n");
    append(markdownV2Quote(digest.closing), digest.closing);
  }
  return { text, visibleLength: visible.length };
}
