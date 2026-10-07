import { TYPO_QUICK_CORRECTION_PROBABILITY } from "../../../consts/aiChat/tools";
import { splitGraphemes } from "../../../libs/text";
import { isEmojiOnly } from "./replyText";
import type {
  CharacterTypo,
  TypoCorrectionMode,
} from "../../../types/aiChat/typo";

/**
 * 出错分支里修正方式由代码侧按 TYPO_QUICK_CORRECTION_PROBABILITY 的概率决定（见
 * consts/aiChat/tools.ts 的注释），模型不参与：命中时补发正确单字（quick），
 * 否则不补发（ignore）。
 */
export function pickTypoCorrectionMode(): TypoCorrectionMode {
  const roll: number = Math.random();
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY) return "quick";
  return "ignore";
}

/**
 * 把 originalChar 在 text 里的第一个出现位置换成 replacementChar，构造出
 * 错字版本的整句话。模型只提供「原字」「错字」两个孤立单字，整句由本函数就地
 * 替换，结果与 text 只差一个字。
 * @returns 两个字长度不为 1、彼此相同、含空白、含 emoji，或 originalChar
 *   压根不在 text 里时返回 null。
 */
export function buildCharacterTypo(text: string, originalChar: string, replacementChar: string): CharacterTypo | null {
  const originalChars: string[] = splitGraphemes(originalChar);
  const replacementChars: string[] = splitGraphemes(replacementChar);
  if (originalChars.length !== 1 || replacementChars.length !== 1) return null;

  const expected: string = originalChars[0]!;
  const typo: string = replacementChars[0]!;
  if (expected === typo) return null;
  if (!expected.trim() || !typo.trim()) return null;
  // 换成的字（以及被换掉的原字）本身不能是 emoji。
  if (isEmojiOnly(expected) || isEmojiOnly(typo)) return null;

  const textChars: string[] = splitGraphemes(text);
  const index: number = textChars.indexOf(expected);
  if (index === -1) return null;

  textChars[index] = typo;
  return { typoText: textChars.join(""), expected, typo };
}
