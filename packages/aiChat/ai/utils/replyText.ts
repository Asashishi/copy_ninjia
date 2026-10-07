import { KEYCAP_SEQUENCE, EMOJI_ATTACHMENT, REGIONAL_INDICATOR } from "../../../consts/aiChat/replyText";
import { truncateInline } from "../../../libs/text";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../../consts/telegram";

/**
 * 首尾那对方向性引号是不是**同一对**（真包裹整段），而不是两对各出一半。
 * 从第二个字符扫到倒数第二个，depth 自 1 起，遇 open 加、遇 close 减，中途
 * 归 0 就说明开头那个已经在中间闭合了。
 */
function isWrappedPair(text: string, open: string, close: string): boolean {
  let depth: number = 1;
  for (let index: number = 1; index < text.length - 1; index++) {
    const char: string = text[index]!;
    if (char === open) depth++;
    else if (char === close) depth--;
    if (depth === 0) return false;
  }
  return true;
}

/**
 * 整段是不是被同一对引号包住：方向性引号经 isWrappedPair 判定首末是否同一对
 * （`「早安」和「晚安」` 的首末分属两对）；ASCII `"` 没有方向，判「全文恰好两个 `"` 且分别在首末」。
 */
function isQuoteWrapped(text: string): boolean {
  const first: string = text[0]!;
  const last: string = text[text.length - 1]!;
  if (first === '"' && last === '"') return text.indexOf('"', 1) === text.length - 1;
  if (first === "「" && last === "」") return isWrappedPair(text, "「", "」");
  if (first === "“" && last === "”") return isWrappedPair(text, "“", "”");
  return false;
}

/**
 * 清洗模型给出的消息文本，得到可直接发送的纯文本：去掉联网搜索可能附带的
 * 行内引用标记（「[[1]](https://…)」）、首尾空白、包裹的代码块围栏和成对引号，
 * 并截断到 Telegram 单条消息上限。
 * 空则返回 null。send_message 正文（见 replyToolset/sendMessage.ts 的
 * parseCleanMessageText）与生图的图注解析（见 replyToolset/imageGeneration.ts）
 * 均经此清洗。
 */
export function cleanReply(raw: string): string | null {
  // URL 部分匹配「非括号非空白字符，或者一对不含嵌套的平衡括号」重复一次以上：
  // .../Foo_(bar) 这类 URL 作为平衡括号整体匹配，遇到孤立 `)` 时在引用标记自己的收尾括号处
  // 停下；不得改成贪婪的 `[^\s]+`。
  let text: string = raw.replace(/\[\[\d+\]\]\((?:[^\s()]|\([^\s()]*\))+\)/g, "").trim();
  if (!text) return null;

  const fenceMatch: RegExpExecArray | null = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  if (text.length >= 2 && isQuoteWrapped(text)) {
    text = text.slice(1, -1).trim();
  }

  if (!text) return null;
  return truncateInline(text, TELEGRAM_MESSAGE_MAX_CHARS);
}

/** 「至少含一个图形 emoji」那一半：图形 emoji 本体，或组成旗帜的区域指示符。 */
const GRAPHIC_EMOJI: RegExp = new RegExp(`[\\p{Extended_Pictographic}${REGIONAL_INDICATOR}]`, "u");

/** 纯表情正文：只由 emoji 本体、旗帜、附属码点与空白组成。 */
const EMOJI_ONLY_BODY: RegExp = new RegExp(
  `^[\\p{Extended_Pictographic}${REGIONAL_INDICATOR}${EMOJI_ATTACHMENT}\\s]+$`,
  "u"
);

/**
 * 文本是否是「纯 emoji 消息」：至少含一个图形 emoji（或完整 keycap 序列），
 * 且除 emoji 本体/旗帜/附属码点（肤色、变体选择符、ZWJ）/空白外没有任何其它
 * 字符。send_message 拒绝这类消息（见 replyToolset/sendMessage.ts）。
 */
export function isEmojiOnly(text: string): boolean {
  // 先剥 keycap：剥出来的算「图形 emoji」那一半，剩下的正文再按附属码点判定。
  const withoutKeycaps: string = text.replace(KEYCAP_SEQUENCE, "");
  const hasKeycap: boolean = withoutKeycaps.length !== text.length;
  if (!hasKeycap && !GRAPHIC_EMOJI.test(text)) return false;
  if (withoutKeycaps.trim().length === 0) return hasKeycap;
  return EMOJI_ONLY_BODY.test(withoutKeycaps);
}
