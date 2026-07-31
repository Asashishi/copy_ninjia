/** 错字发出后的纠正策略。 */
export type TypoCorrectionMode = "quick" | "ignore";

/** 一次经字素校验的单字替换。 */
export interface CharacterTypo {
  readonly typoText: string;
  readonly expected: string;
  readonly typo: string;
}

/** 一条 send_message 是否采用本轮错字机会的完整判定。 */
export interface TypoDecision {
  shouldUseTypo: boolean;
  textToSend: string;
  correctionText: string | null;
  mode: TypoCorrectionMode | null;
  rejectedReason: string | null;
}
