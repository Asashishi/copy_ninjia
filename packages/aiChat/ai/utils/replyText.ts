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
 * 整段是不是被一对引号包住。只看首末两个字符是不够的：
 * `「早安」和「晚安」` 的首末确实是 `「` 和 `」`，但它们分属两对，剥掉就把
 * 正文两头各啃掉一个字——而这个字符串就是最终发进群里的正文。
 * ASCII `"` 没有方向，无从数嵌套，改判「全文恰好两个 `"` 且分别在首末」。
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
 * 行内引用标记（「[[1]](https://…)」，发到群里既丑又暴露机器人身份）、
 * 首尾空白、包裹的代码块围栏和成对引号，并截断到 Telegram 单条消息上限。
 * 空则返回 null。aiChat/ai/tools/replyToolset/sendMessage.ts 的 send_message 工具、以及模型
 * 不走工具时的最终正文兜底（见 workers/aiChat/replyPipeline.ts）都过这一道。
 */
export function cleanReply(raw: string): string | null {
  // URL 部分允许成对括号（如维基百科的 .../Foo_(bar)），但不能用贪婪的
  // `[^\s]+`：中文正文经常整行没有空白，贪婪匹配会一路吃到本行最后一个 `)`，把引用标记之后、这个
  // 无关 `)` 之前的大段正文一并吞掉。改成「非括号非空白字符，或者一对不
  // 含嵌套的平衡括号」重复一次以上：维基百科式的 .../Foo_(bar) 能作为一个
  // 平衡括号整体吃掉，而遇到与 URL 无关的孤立 `)`（前面没有配对的 `(`）时
  // 无法再继续匹配，会在引用标记自己的收尾括号处停下，不会越界。
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
 * 字符。这类消息被 send_message 拒绝——机器人不直接发表情，能直接发的画面
 * 表达只有贴纸，对消息表态用 add_reaction。
 */
export function isEmojiOnly(text: string): boolean {
  // 先剥 keycap：剥出来的算「图形 emoji」那一半，剩下的正文再按附属码点判定。
  const withoutKeycaps: string = text.replace(KEYCAP_SEQUENCE, "");
  const hasKeycap: boolean = withoutKeycaps.length !== text.length;
  if (!hasKeycap && !GRAPHIC_EMOJI.test(text)) return false;
  if (withoutKeycaps.trim().length === 0) return hasKeycap;
  return EMOJI_ONLY_BODY.test(withoutKeycaps);
}
