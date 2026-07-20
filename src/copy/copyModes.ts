import type { CopyMode } from "../types/chatState";
import { translateToJapanese } from "./translate";
import { NYA_SUFFIX } from "../consts/copyModes";
import { splitGraphemes } from "../libs/text";

/**
 * 按 Unicode 扩展字形簇（grapheme cluster）反转字符串（若 Intl.Segmenter 不可用则
 * 退化为按码点反转），避免 emoji / 代理对 / 组合符号被拆散导致乱码。
 * @param text 待反转的文本。
 */
function reverseText(text: string): string {
  return splitGraphemes(text).reverse().join("");
}

/**
 * 给尚未以 喵~ 结尾的文本追加 " 喵~"（前面带一个半角空格）。安全校验由调用方负责
 * （见 handleIncomingMessage 中的 isPlainText）——本函数只会在已通过该校验的消息上
 * 运行，且结果仍会通过不带 parse_mode 的 sendMessage() 发送。
 * @param text 待追加后缀的文本。
 */
function appendNyaSuffix(text: string): string {
  return text.endsWith(NYA_SUFFIX) ? text : text + " " + NYA_SUFFIX;
}

/**
 * 对纯文本消息应用当前激活的 copy mode 文本变换。
 * 没有模式、或变换本身失败（比如 "ja" 翻译调用报错）时返回 null——调用方此时应
 * 退化为通过 copyMessage() 原样转发消息，而不是直接丢弃它。
 * @param text 待变换的纯文本消息。
 * @param mode 当前激活的 copy mode（如果有）。
 */
export async function applyCopyModeTransform(text: string, mode: CopyMode | undefined): Promise<string | null> {
  switch (mode) {
    case "reverse":
      return reverseText(text);
    case "nya":
      return appendNyaSuffix(text);
    case "ja":
      return await translateToJapanese(text);
    default:
      return null;
  }
}

/**
 * 为 /*_copy 的启动提示语描述该 copy mode 的效果，例如
 * "，之后 TA 说的纯文字都会被本天才倒过来念"。没有模式时返回 ""。
 * @param mode 即将启动的 copy mode。
 */
export function describeCopyModeEffect(mode: CopyMode | undefined): string {
  switch (mode) {
    case "reverse":
      return "，之后 TA 说的纯文字都会被本天才倒过来念";
    case "nya":
      return "，之后 TA 说的纯文字后面本天才都会给它加上喵~";
    case "ja":
      return "，之后 TA 说的纯文字都会被本天才翻译成日语哦";
    default:
      return "";
  }
}
