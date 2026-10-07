import type { TelegramParseMode } from "../types/telegram";

/** Telegram MarkdownV2 拼装（libs/telegramMarkdown.ts）使用的常量。 */

/** 发送边界设置的解析模式；全仓只此一种。 */
export const MARKDOWN_V2_PARSE_MODE: TelegramParseMode = "MarkdownV2";

/** 正文里必须加 `\` 的字符：Bot API 列出的保留字符与 `\` 本身，全局匹配。 */
export const MARKDOWN_V2_TEXT_ESCAPE_PATTERN: RegExp = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** `code` 与 `pre` 内部必须加 `\` 的字符：只有反引号与 `\`，全局匹配。 */
export const MARKDOWN_V2_CODE_ESCAPE_PATTERN: RegExp = /[`\\]/g;

/** 内联链接 `(...)` 内部必须加 `\` 的字符：只有 `)` 与 `\`，全局匹配。 */
export const MARKDOWN_V2_URL_ESCAPE_PATTERN: RegExp = /[)\\]/g;

/** 转义替换串：在匹配到的字符前加一个 `\`。 */
export const MARKDOWN_V2_ESCAPE_REPLACEMENT: string = "\\$&";
