import { truncateInline } from "../../libs/text";
import { TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";

/**
 * 清洗模型给出的消息文本，得到可直接发送的纯文本：去掉联网搜索可能附带的
 * 行内引用标记（「[[1]](https://…)」，发到群里既丑又暴露机器人身份）、
 * 首尾空白、包裹的代码块围栏和成对引号，并截断到 Telegram 单条消息上限。
 * 空则返回 null。ai/tools/replyToolset.ts 的 send_message 工具、以及模型
 * 不走工具时的最终正文兜底（见 workers/aiChat/replyPipeline.ts）都过这一道。
 */
export function cleanReply(raw: string): string | null {
  // URL 部分故意不排除 `)`：链接本身带括号很常见（如维基百科的消歧义链接
  // .../Foo_(bar)），排除 `)` 会让匹配在 URL 内部就截停。但也不能简单放开
  // 成贪婪的 `[^\s]+`（曾经的实现）：中文正文经常整行没有任何空白字符，
  // 贪婪匹配会一路吃到本行最后一个 `)` 才回溯停下，把引用标记之后、这个
  // 无关 `)` 之前的大段正文一并吞掉。改成「非括号非空白字符，或者一对不
  // 含嵌套的平衡括号」重复一次以上：维基百科式的 .../Foo_(bar) 能作为一个
  // 平衡括号整体吃掉，而遇到与 URL 无关的孤立 `)`（前面没有配对的 `(`）时
  // 无法再继续匹配，会在引用标记自己的收尾括号处停下，不会越界。
  let text: string = raw.replace(/\[\[\d+\]\]\((?:[^\s()]|\([^\s()]*\))+\)/g, "").trim();
  if (!text) return null;

  const fenceMatch = text.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    text = fenceMatch[1].trim();
  }

  if (text.length >= 2) {
    const first: string = text[0]!;
    const last: string = text[text.length - 1]!;
    if ((first === '"' && last === '"') || (first === "「" && last === "」") || (first === "“" && last === "”")) {
      text = text.slice(1, -1).trim();
    }
  }

  if (!text) return null;
  return truncateInline(text, TELEGRAM_MESSAGE_MAX_CHARS);
}

/**
 * 文本是否是「纯 emoji 消息」：至少含一个图形 emoji，且除 emoji 本体/emoji
 * 组件（肤色、变体选择符、ZWJ 等）/空白外没有任何其它字符。这类消息被
 * send_message 拒绝——机器人不直接发表情，能直接发的画面表达只有贴纸，
 * 对消息表态用 add_reaction。
 */
export function isEmojiOnly(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text) && /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(text);
}
