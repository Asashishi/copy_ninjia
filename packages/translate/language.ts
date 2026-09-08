import {
  TRANSLATE_CHINESE_EVIDENCE,
  TRANSLATE_CHINESE_TEXT,
  TRANSLATE_ENGLISH_EVIDENCE,
  TRANSLATE_ENGLISH_TEXT,
  TRANSLATE_JAPANESE_EVIDENCE,
  TRANSLATE_JAPANESE_TEXT,
  TRANSLATE_NEUTRAL_TEXT,
  TRANSLATE_UKRAINIAN_EVIDENCE,
  TRANSLATE_UKRAINIAN_TEXT,
  TRANSLATE_RUSSIAN_EVIDENCE,
  TRANSLATE_RUSSIAN_TEXT,
} from "../consts/translate";
import type { TranslateLanguage } from "../types/translate";
import { TRANSLATE_TRADITIONAL_HAN } from "../consts/translateHan";

/**
 * 仅对符合目标文字形态或完全中性的文本跳过翻译；不创建中间数组。
 * 正则按字形启发式识别，共用汉字词、无重音拉丁短句和共用西里尔字母短句仍可能有语种歧义。
 */
export function canCopyWithoutTranslation(text: string, language: TranslateLanguage): boolean {
  if (TRANSLATE_NEUTRAL_TEXT.test(text)) return true;
  switch (language) {
    case "ja":
      return TRANSLATE_JAPANESE_EVIDENCE.test(text) && TRANSLATE_JAPANESE_TEXT.test(text);
    case "cn":
      return TRANSLATE_CHINESE_EVIDENCE.test(text) &&
        TRANSLATE_CHINESE_TEXT.test(text) && !TRANSLATE_TRADITIONAL_HAN.test(text);
    case "en":
      return TRANSLATE_ENGLISH_EVIDENCE.test(text) && TRANSLATE_ENGLISH_TEXT.test(text);
    case "uk":
      return TRANSLATE_UKRAINIAN_EVIDENCE.test(text) && TRANSLATE_UKRAINIAN_TEXT.test(text);
    case "ru":
      return TRANSLATE_RUSSIAN_EVIDENCE.test(text) && TRANSLATE_RUSSIAN_TEXT.test(text);
  }
}
