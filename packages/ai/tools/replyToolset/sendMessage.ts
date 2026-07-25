import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../consts/aiChat/tools";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { sendMessageWithResult } from "../../../infra/telegram";
import { sleep } from "../../../libs/sleep";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../types/telegram";
import { isEmojiOnly } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { parseBooleanField } from "../../utils/toolArgs";
import {
  isDuplicateOfSentMessage,
  recordSentMessage,
  type RoundMessageState,
} from "./messageState";
import {
  applyQuickTypoCorrection,
  decideMessageTypo,
  parseCleanMessageText,
} from "./typoHandling";
import type { TypoDecision } from "./typoHandling";

/** 构造本轮 send_message 执行器；总动作计数仍由外层编排器统一结算。 */
export function createSendMessageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  getActionsUsed: () => number
): (argumentsJson: string) => Promise<string> {
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }
    const text: string | null = parseCleanMessageText(argumentsJson);
    if (!text) return toolError("Invalid or empty text");
    if (isEmojiOnly(text)) {
      return toolError(
        "Emoji-only messages are not allowed: send a sticker (send_sticker) or react to the trigger message (add_reaction) instead"
      );
    }
    if (isDuplicateOfSentMessage(state, text)) {
      return toolError(
        "An identical message was already sent in this round; do not repeat yourself. Say something new, or use add_reaction / send_sticker instead"
      );
    }

    const typo: TypoDecision = decideMessageTypo({
      argumentsJson,
      text,
      roundHasTypo: ctx.roundHasTypo,
      typoAlreadyUsed: state.typoUsedThisRound,
      remainingActions: HARD_MAX_ACTIONS_PER_REPLY - getActionsUsed(),
    });
    if (typo.shouldUseTypo) state.typoUsedThisRound = true;

    ctx.chatAction.set("typing");
    await sleep(typingDelayMs(typo.textToSend));
    ctx.chatAction.set("idle");
    await ctx.chatAction.settle();
    if (!ctx.isActive()) {
      return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    }

    const replyToTrigger: boolean = parseBooleanField(argumentsJson, "reply_to_trigger");
    const replyToMessageId: number | undefined = replyToTrigger ? ctx.replyToMessageId : undefined;
    const sent: TelegramSendResult | undefined = await sendMessageWithResult({
      chatId: ctx.chatId,
      text: typo.textToSend,
      replyToMessageId,
    });
    if (sent === undefined) return toolError("Failed to send message");

    recordSentMessage({
      ctx,
      state,
      text: typo.textToSend,
      messageId: sent.messageId,
      ...(sent.repliedToMessageId !== undefined ? { repliedToMessageId: sent.repliedToMessageId } : {}),
    });
    state.sentCanonicalTexts.set(sent.messageId, text);
    if (typo.shouldUseTypo && typo.correctionText) {
      // 无论本轮落在 90% 补字还是 10% 没发现，纠正都只由
      // 执行侧决定，不允许模型根据 functionResponse 自行补单字。
      state.reservedCorrectionText = typo.correctionText;
    }
    let actionsUsedByTool: number = 1;

    if (
      typo.shouldUseTypo &&
      typo.mode === "quick" &&
      typo.correctionText &&
      !isEmojiOnly(typo.correctionText)
    ) {
      const correctionSent: boolean = await applyQuickTypoCorrection(ctx, state, typo.correctionText);
      if (correctionSent) actionsUsedByTool++;
      return JSON.stringify({
        success: true,
        message_id: sent.messageId,
        actions_used: actionsUsedByTool,
        typo: { mode: "quick", correction: correctionSent ? "sent" : "failed" },
      });
    }

    return JSON.stringify({
      success: true,
      message_id: sent.messageId,
      actions_used: actionsUsedByTool,
      ...(typo.rejectedReason ? { typo_rejected: typo.rejectedReason } : {}),
    });
  };
}
