import { logger } from "../../../../infra/logger";
import { sleep } from "../../../../libs/sleep";
import {
  TYPO_MIN_REMAINING_ACTIONS,
  TYPO_QUICK_CORRECTION_MAX_MS,
  TYPO_QUICK_CORRECTION_MIN_MS,
  TYPO_QUICK_CORRECTION_TYPING_MS,
} from "../../../../consts/aiChat/tools";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  ReplyActionPause,
  ReplyToolContext,
} from "../../../../types/aiChat/replies";
import type {
  CharacterTypo,
  TypoDecision,
} from "../../../../types/aiChat/typo";
import { containsRenderableCommand } from "../../../../libs/renderableCommand";
import { cleanReply, isEmojiOnly } from "../../utils/replyText";
import {
  buildCharacterTypo,
  pickTypoCorrectionMode,
} from "../../utils/typo";
import { randomDelayMs } from "../../utils/timing";
import { parseStringField } from "../../utils/toolArgs";
import { sendDirectMessage } from "./messageState";

export interface DecideMessageTypoParams {
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
  // 错字版本要单独判一次可点击命令：send_message 那道守卫看的是**替换前**的正文，
  // 而真正发出去的是这一串。替换字由模型给，`/` 既不是空白也不是 emoji，能过
  // buildCharacterTypo 的全部校验——正文写「喵 xbatch_kick」、替换 x→/ 就凑出了
  // 一条可点击的 `/batch_kick`。守卫和被守卫的值必须是同一个字符串（同
  // auto/message/echo.ts 的同类说明）。命中只作废这次手滑、正文照常发出。
  const shouldUseTypo: boolean = roundHasTypo &&
    !typoAlreadyUsed &&
    characterTypo !== null &&
    !isEmojiOnly(typoText!) &&
    !containsRenderableCommand(typoText!) &&
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
      : containsRenderableCommand(typoText!)
      ? "typo candidate was rejected: the resulting message would contain a slash command Telegram renders as tappable"
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

export interface ApplyQuickTypoCorrectionParams {
  ctx: ReplyToolContext;
  /** 本步动作的心跳句柄与拟人停顿，与错字消息同一步。 */
  chatAction: ChatActionControl;
  pause: ReplyActionPause;
  correctionText: string;
}

/**
 * 错字消息落地后补发正确单字：先静默 TYPO_QUICK_CORRECTION_MIN_MS～MAX_MS，再模拟固定
 * TYPO_QUICK_CORRECTION_TYPING_MS 的「正在输入」，切 idle、等状态收敛后发送。返回补字是否送达。
 */
export async function applyQuickTypoCorrection({
  ctx,
  chatAction,
  pause,
  correctionText,
}: ApplyQuickTypoCorrectionParams): Promise<boolean> {
  try {
    await sleep(
      randomDelayMs(TYPO_QUICK_CORRECTION_MIN_MS, TYPO_QUICK_CORRECTION_MAX_MS),
      ctx.signal
    );
    if (await pause("typing", TYPO_QUICK_CORRECTION_TYPING_MS) !== null) return false;
    chatAction.set("idle");
    await chatAction.settle();
    const correctionMessageId: number | undefined = await sendDirectMessage({
      ctx,
      text: correctionText,
    });
    if (correctionMessageId === undefined) return false;
    return true;
  } catch (error: unknown) {
    if (ctx.signal?.aborted === true) return false;
    logger.error("Error while applying quick typo correction:", error);
    return false;
  }
}

/** send_message 入参的正文解析仍属于错字前的共同清洗步骤。 */
export function parseCleanMessageText(argumentsJson: string): string | null {
  const raw: string | null = parseStringField(argumentsJson, "text");
  return raw === null ? null : cleanReply(raw);
}
