import { TYPO_QUICK_CORRECTION_PROBABILITY } from "../../../consts/aiChat/tools";
import { splitGraphemes } from "../../../libs/text";
import { isEmojiOnly } from "./replyText";
import type {
  CharacterTypo,
  TypoCorrectionMode,
} from "../../../types/aiChat/typo";

// 字素簇切分复用 libs/text.ts，不另起一份：那边的 Segmenter 是惰性构造 +
// try/catch 降级的，模块作用域直接 new 会让 ICU 不全的运行时连 import 都失败。

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
