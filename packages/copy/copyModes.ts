import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CopyMode } from "../types/chatState";
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
 * （见 auto/message/echo.ts 对变换前后两串的 containsRenderableCommand 守卫），结果以
 * 不带实体、不设 parse_mode 的字符串发出（正文或新图注）。
 * @param text 待追加后缀的文本。
 */
function appendNyaSuffix(text: string): string {
  return text.endsWith(NYA_SUFFIX) ? text : text + " " + NYA_SUFFIX;
}

/**
 * 对复读的文字（正文或图注）应用当前激活的 copy mode 文本变换；没有模式时原样返回。
 * @param text 待变换的文字。
 * @param mode 当前激活的 copy mode（如果有）。
 */
export function applyCopyModeTransform(text: string, mode: CopyMode | undefined): string {
  switch (mode) {
    case "reverse":
      return reverseText(text);
    case "nya":
      return appendNyaSuffix(text);
    default:
      return text;
  }
}

/**
 * 为 /*_copy 的启动提示语描述该 copy mode 的效果，例如
 * "，之后 TA 说的纯文字都会被本天才倒过来念"。没有模式时返回 ""。
 * @param mode 即将启动的 copy mode。
 */
export function describeCopyModeEffect(mode: CopyMode | undefined, atmosphere: AtmosphereTexts = ATMOSPHERE_TEXTS.teasing): string {
  switch (mode) {
    case "reverse":
      return atmosphere.NOTICE_TEXTS.copyReverseEffect;
    case "nya":
      return atmosphere.NOTICE_TEXTS.copyNyaEffect;
    default:
      return "";
  }
}
