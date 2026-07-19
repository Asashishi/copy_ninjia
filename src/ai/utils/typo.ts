import { TYPO_QUICK_CORRECTION_PROBABILITY, TYPO_RECALL_CORRECTION_PROBABILITY } from "../../consts/aiChat/tools";
import { isEmojiOnly } from "./replyText";

export type TypoCorrectionMode = "quick" | "recall" | "ignore";

export interface CharacterTypo {
  readonly typoText: string;
  readonly expected: string;
  readonly typo: string;
}

/**
 * 出错分支里修正方式由代码侧按概率决定，模型不参与（见 consts/aiChat.ts
 * 的 TYPO_QUICK_CORRECTION_PROBABILITY 注释）：落不进快速补字/撤回重发
 * 两个区间的剩余概率即「假装没发现」。
 */
export function pickTypoCorrectionMode(): TypoCorrectionMode {
  const roll: number = Math.random();
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY) return "quick";
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY + TYPO_RECALL_CORRECTION_PROBABILITY) return "recall";
  return "ignore";
}

/**
 * 把 originalChar 在 text 里的第一个出现位置换成 replacementChar，构造出
 * 错字版本的整句话。不再要求模型把整句话重新打一遍、再靠 diff 两个模型
 * 各自生成的完整字符串来验证只有一处差异；长句复现可能缩短或改写正文，
 * 使正确的错字意图被长度/diff 校验误拒。只问模型要「原字」「错字」两个
 * 孤立单字后，替换在结构上
 * 必然只有一处、必然和 text 等长，不再依赖模型的长句复现保真度。
 * @returns 两个字长度不为 1、彼此相同、含空白、含 emoji，或 originalChar
 *   压根不在 text 里时返回 null。
 */
export function buildCharacterTypo(text: string, originalChar: string, replacementChar: string): CharacterTypo | null {
  const originalChars: string[] = Array.from(originalChar);
  const replacementChars: string[] = Array.from(replacementChar);
  if (originalChars.length !== 1 || replacementChars.length !== 1) return null;

  const expected: string = originalChars[0]!;
  const typo: string = replacementChars[0]!;
  if (expected === typo) return null;
  if (!expected.trim() || !typo.trim()) return null;
  // 换成的字（以及被换掉的原字）本身不能是 emoji。
  if (isEmojiOnly(expected) || isEmojiOnly(typo)) return null;

  const textChars: string[] = Array.from(text);
  const index: number = textChars.indexOf(expected);
  if (index === -1) return null;

  textChars[index] = typo;
  return { typoText: textChars.join(""), expected, typo };
}
