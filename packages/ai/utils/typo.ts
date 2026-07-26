import { TYPO_QUICK_CORRECTION_PROBABILITY } from "../../consts/aiChat/tools";
import { isEmojiOnly } from "./replyText";

export type TypoCorrectionMode = "quick" | "ignore";

/**
 * 按字素簇切分，而不是按码点。分解写法的日文假名（か + 浊点 = が）、带组合
 * 标记的拉丁字母都是一个字素两个码点：按码点切会命中后面还挂着组合标记的
 * 基字，替换后标记留在原地——轻则换出来的字跟模型说的「原字/错字」对不上，
 * 重则组合标记落到一个压根不搭配的基字上，发出去是乱码。
 */
const GRAPHEME_SEGMENTER: Intl.Segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

function splitGraphemes(text: string): string[] {
  return [...GRAPHEME_SEGMENTER.segment(text)].map(
    (segment: Intl.SegmentData): string => segment.segment
  );
}

export interface CharacterTypo {
  readonly typoText: string;
  readonly expected: string;
  readonly typo: string;
}

/**
 * 出错分支里修正方式由代码侧按概率决定，模型不参与（见 consts/aiChat.ts
 * 的 TYPO_QUICK_CORRECTION_PROBABILITY 注释）：90% 补发正确单字，
 * 剩余 10% 即「没发现」；不再存在撤回后重发正确全文的分支。
 */
export function pickTypoCorrectionMode(): TypoCorrectionMode {
  const roll: number = Math.random();
  if (roll < TYPO_QUICK_CORRECTION_PROBABILITY) return "quick";
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
