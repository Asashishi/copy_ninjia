import { deleteMessage } from "../../../infra/telegram";
import { logger } from "../../../infra/logger";
import { sleep } from "../../../libs/sleep";
import {
  TYPO_MIN_REMAINING_ACTIONS,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_RECALL_DELETE_MAX_MS,
  TYPO_RECALL_DELETE_MIN_MS,
} from "../../../consts/aiChat/tools";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import { cleanReply, isEmojiOnly } from "../../utils/replyText";
import {
  buildCharacterTypo,
  pickTypoCorrectionMode,
  type CharacterTypo,
  type TypoCorrectionMode,
} from "../../utils/typo";
import { randomDelayMs } from "../../utils/timing";
import { parseStringField } from "../../utils/toolArgs";
import { sendDirectMessage, type RoundMessageState } from "./messageState";

export interface TypoDecision {
  shouldUseTypo: boolean;
  textToSend: string;
  correctionText: string | null;
  mode: TypoCorrectionMode | null;
  rejectedReason: string | null;
}

interface DecideMessageTypoParams {
  argumentsJson: string;
  text: string;
  roundHasTypo: boolean;
  typoAlreadyUsed: boolean;
  remainingActions: number;
}

/** 解析模型提交的两枚单字并决定本条消息是否采用本轮唯一一次手滑。 */
export function decideMessageTypo({
  argumentsJson,
  text,
  roundHasTypo,
  typoAlreadyUsed,
  remainingActions,
}: DecideMessageTypoParams): TypoDecision {
  const rawOriginalChar: string | null = parseStringField(argumentsJson, "typo_original_char");
  const rawReplacementChar: string | null = parseStringField(argumentsJson, "typo_replacement_char");
  const originalChar: string | null = rawOriginalChar ? rawOriginalChar.trim() : null;
  const replacementChar: string | null = rawReplacementChar ? rawReplacementChar.trim() : null;
  const characterTypo: CharacterTypo | null = originalChar && replacementChar
    ? buildCharacterTypo(text, originalChar, replacementChar)
    : null;
  const typoText: string | null = characterTypo?.typoText ?? null;
  const shouldUseTypo: boolean = roundHasTypo &&
    !typoAlreadyUsed &&
    characterTypo !== null &&
    !isEmojiOnly(typoText!) &&
    remainingActions >= TYPO_MIN_REMAINING_ACTIONS;
  const typoAttempted: boolean = roundHasTypo &&
    !!originalChar &&
    !!replacementChar &&
    originalChar !== replacementChar;
  const rejectedReason: string | null = typoAttempted && !shouldUseTypo
    ? typoAlreadyUsed
      ? "already used the one allowed typo this round; this message will send as-is"
      : characterTypo === null
      ? "typo_original_char/typo_replacement_char were rejected: each must be exactly one character, differ from each other, not be emoji, and typo_original_char must actually appear in text"
      : isEmojiOnly(typoText!)
      ? "typo candidate was rejected: the resulting message would be emoji-only"
      : "typo candidate was rejected: not enough remaining action budget this round"
    : null;

  return {
    shouldUseTypo,
    textToSend: shouldUseTypo ? typoText! : text,
    correctionText: characterTypo?.expected ?? null,
    mode: shouldUseTypo ? pickTypoCorrectionMode() : null,
    rejectedReason,
  };
}

export function scheduleQuickTypoCorrection(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  correctionText: string
): void {
  state.pendingCorrectionText = correctionText;
  void (async (): Promise<void> => {
    await sleep(randomDelayMs(TYPO_QUICK_CORRECTION_MIN_MS, TYPO_QUICK_CORRECTION_MAX_MS));
    const correctionMessageId: number | undefined = await sendDirectMessage({
      ctx,
      state,
      text: correctionText,
      allowInactive: true,
    });
    if (correctionMessageId !== undefined) {
      state.sentCanonicalTexts.set(correctionMessageId, correctionText);
    }
    if (state.pendingCorrectionText === correctionText) state.pendingCorrectionText = null;
  })().catch((error: unknown) => {
    logger.error("Error while applying scheduled quick typo correction:", error);
  });
}

export function scheduleRecallTypoCorrection({
  ctx,
  state,
  sentMessageId,
  correctedText,
  replyToMessageId,
}: {
  ctx: ReplyToolContext;
  state: RoundMessageState;
  sentMessageId: number;
  correctedText: string;
  replyToMessageId?: number;
}): void {
  void (async (): Promise<void> => {
    await sleep(randomDelayMs(TYPO_RECALL_DELETE_MIN_MS, TYPO_RECALL_DELETE_MAX_MS));
    const deleted: boolean = await deleteMessage(ctx.chatId, sentMessageId);
    if (!deleted) return;
    // 旧 canonical 条目保留到纠正消息发送完成，堵住删除与重发之间的判重空窗。
    state.deletableMessageIds.delete(sentMessageId);
    state.messageCount = Math.max(0, state.messageCount - 1);
    const correctedMessageId: number | undefined = await sendDirectMessage({
      ctx,
      state,
      text: correctedText,
      replyToMessageId,
      allowInactive: true,
    });
    if (correctedMessageId !== undefined) state.sentCanonicalTexts.set(correctedMessageId, correctedText);
    state.sentCanonicalTexts.delete(sentMessageId);
  })().catch((error: unknown) => {
    logger.error("Error while applying scheduled typo recall correction:", error);
  });
}

/** send_message 入参的正文解析仍属于错字前的共同清洗步骤。 */
export function parseCleanMessageText(argumentsJson: string): string | null {
  const raw: string | null = parseStringField(argumentsJson, "text");
  return raw === null ? null : cleanReply(raw);
}
