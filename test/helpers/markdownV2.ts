/**
 * 测试用的 MarkdownV2 参照解析器：按 Bot API「MarkdownV2 style」与 TDLib 的解析口径，
 * 把一段 MarkdownV2 原文还原成 Telegram 实际显示的正文与实体。
 *
 * Telegram 没有「只解析、不发送」的接口，单测靠它核对两件事：原文不会被拒收（任何
 * 未转义的保留字符、未闭合的格式段都抛错），以及解析后的可见正文与实体范围符合预期。
 * 只覆盖本项目会生成的格式：粗体、斜体、下划线、删除线、剧透、内联代码、代码块、
 * 内联链接与行首引用。
 */

/** 解析出的一个实体；偏移与长度按 UTF-16 码元计。 */
export interface ParsedMarkdownV2Entity {
  readonly type: "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code" | "pre" | "text_link" | "blockquote";
  readonly offset: number;
  readonly length: number;
  readonly language?: string;
  readonly url?: string;
}

/** 解析结果：Telegram 显示的正文与实体表（按闭合顺序）。 */
export interface ParsedMarkdownV2 {
  readonly text: string;
  readonly entities: readonly ParsedMarkdownV2Entity[];
}

type OpenEntityType = Exclude<ParsedMarkdownV2Entity["type"], "blockquote">;

interface OpenEntity {
  readonly type: OpenEntityType;
  readonly offset: number;
  readonly language: string | undefined;
}

const RESERVED: string = "_*[]()~`>#+-=|{}.!";

/** 当前最内层格式段是否在位置 i 结束。 */
function closesAt(open: OpenEntity, source: string, i: number): boolean {
  const c: string = source[i]!;
  switch (open.type) {
    case "bold": return c === "*";
    case "italic": return c === "_" && source[i + 1] !== "_";
    case "underline": return c === "_" && source[i + 1] === "_";
    case "strikethrough": return c === "~";
    case "spoiler": return c === "|" && source[i + 1] === "|";
    case "code": return c === "`";
    case "pre": return source.startsWith("```", i);
    case "text_link": return c === "]";
  }
}

/** 解析整段原文；Telegram 会拒收的原文一律抛错。 */
export function parseMarkdownV2(source: string): ParsedMarkdownV2 {
  let text: string = "";
  const entities: ParsedMarkdownV2Entity[] = [];
  const stack: OpenEntity[] = [];
  let quoteStart: number | undefined;

  for (let i: number = 0; i < source.length; i++) {
    const c: string = source[i]!;
    const top: OpenEntity | undefined = stack.at(-1);
    const inCode: boolean = top?.type === "code" || top?.type === "pre";

    if (c === "\\") {
      const next: string | undefined = source[i + 1];
      if (next !== undefined && next.charCodeAt(0) > 0 && next.charCodeAt(0) <= 126) {
        text += next;
        i++;
        continue;
      }
    }
    if (c === "\n" && quoteStart !== undefined && source[i + 1] !== ">") {
      entities.push({ type: "blockquote", offset: quoteStart, length: text.length - quoteStart });
      quoteStart = undefined;
    }
    if (!inCode && c === ">" && (i === 0 || source[i - 1] === "\n")) {
      quoteStart ??= text.length;
      continue;
    }
    const reserved: boolean = inCode ? c === "`" : RESERVED.includes(c);
    if (!reserved) {
      text += c;
      continue;
    }

    if (top !== undefined && closesAt(top, source, i)) {
      stack.pop();
      let url: string | undefined;
      if (top.type === "underline" || top.type === "spoiler") i++;
      else if (top.type === "pre") i += 2;
      else if (top.type === "text_link") {
        if (source[i + 1] !== "(") throw new Error(`text_link without a URL at ${i}`);
        i += 2;
        url = "";
        while (i < source.length && source[i] !== ")") {
          const next: string | undefined = source[i + 1];
          if (source[i] === "\\" && next !== undefined && next.charCodeAt(0) > 0 && next.charCodeAt(0) <= 126) {
            url += next;
            i += 2;
            continue;
          }
          url += source[i];
          i++;
        }
        if (source[i] !== ")") throw new Error("Can't find end of a URL");
      }
      if (text.length > top.offset) {
        entities.push({
          type: top.type,
          offset: top.offset,
          length: text.length - top.offset,
          ...(top.language === undefined ? {} : { language: top.language }),
          ...(url === undefined ? {} : { url }),
        });
      }
      continue;
    }

    let type: OpenEntityType;
    let language: string | undefined;
    switch (c) {
      case "_":
        if (source[i + 1] === "_") {
          type = "underline";
          i++;
        } else {
          type = "italic";
        }
        break;
      case "*": type = "bold"; break;
      case "~": type = "strikethrough"; break;
      case "|":
        if (source[i + 1] !== "|") throw new Error(`Character '|' is reserved at ${i}`);
        type = "spoiler";
        i++;
        break;
      case "[": type = "text_link"; break;
      case "`":
        if (source.startsWith("```", i)) {
          type = "pre";
          i += 3;
          let languageEnd: number = i;
          while (languageEnd < source.length && !/\s/.test(source[languageEnd]!) && source[languageEnd] !== "`") {
            languageEnd++;
          }
          if (languageEnd !== i && languageEnd < source.length && source[languageEnd] !== "`") {
            language = source.slice(i, languageEnd);
            i = languageEnd;
          }
          if (source[i] === "\n" || source[i] === "\r") i++;
          i--;
        } else {
          type = "code";
        }
        break;
      default:
        throw new Error(`Character '${c}' is reserved and must be escaped with the preceding '\\' at ${i}`);
    }
    stack.push({ type, offset: text.length, language });
  }

  const unclosed: OpenEntity | undefined = stack.at(-1);
  if (unclosed !== undefined) throw new Error(`Can't find end of the ${unclosed.type} entity`);
  if (quoteStart !== undefined) {
    entities.push({ type: "blockquote", offset: quoteStart, length: text.length - quoteStart });
  }
  return { text, entities };
}
