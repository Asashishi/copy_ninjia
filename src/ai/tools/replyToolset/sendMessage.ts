import { MAX_ACTIONS_PER_REPLY } from "../../../consts/aiChat/tools";
import { sendMessage } from "../../../infra/telegram";
import { sleep } from "../../../libs/sleep";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import { isEmojiOnly } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { parseBooleanField } from "../../utils/toolArgs";
import {
  isDuplicateOfSentMessage,
  recordSentMessage,
  type RoundMessageState,
} from "./messageState";
import {
  decideMessageTypo,
  parseCleanMessageText,
  scheduleQuickTypoCorrection,
  scheduleRecallTypoCorrection,
} from "./typoHandling";

/** 构造本轮 send_message 执行器；总动作计数仍由外层编排器统一结算。 */
export function createSendMessageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  getActionsUsed: () => number
): (argumentsJson: string) => Promise<string> {
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) {
      return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    }
    const text: string | null = parseCleanMessageText(argumentsJson);
    if (!text) return JSON.stringify({ error: "Invalid or empty text" });
    if (isEmojiOnly(text)) {
      return JSON.stringify({
        error: "Emoji-only messages are not allowed: send a sticker (send_sticker) or react to the trigger message (add_reaction) instead",
      });
    }
    if (isDuplicateOfSentMessage(state, text)) {
      return JSON.stringify({
        error: "An identical message was already sent in this round; do not repeat yourself. Say something new, or use add_reaction / send_sticker instead",
      });
    }

    const typo = decideMessageTypo({
      argumentsJson,
      text,
      roundHasTypo: ctx.roundHasTypo,
      typoAlreadyUsed: state.typoUsedThisRound,
      remainingActions: MAX_ACTIONS_PER_REPLY - getActionsUsed(),
    });
    if (typo.shouldUseTypo) state.typoUsedThisRound = true;

    ctx.chatAction.set("typing");
    await sleep(typingDelayMs(typo.textToSend));
    ctx.chatAction.set("idle");
    await ctx.chatAction.settle();
    if (!ctx.isActive()) {
      return JSON.stringify({ error: "Reply invalidated because AI chat was disabled" });
    }

    const replyToTrigger: boolean = parseBooleanField(argumentsJson, "reply_to_trigger");
    const replyToMessageId: number | undefined = replyToTrigger ? ctx.replyToMessageId : undefined;
    const sentMessageId: number | undefined = await sendMessage({
      chatId: ctx.chatId,
      text: typo.textToSend,
      replyToMessageId,
    });
    if (sentMessageId === undefined) return JSON.stringify({ error: "Failed to send message" });

    recordSentMessage({ ctx, state, text: typo.textToSend, messageId: sentMessageId });
    state.sentCanonicalTexts.set(sentMessageId, text);
    let actionsUsedByTool: number = 1;

    if (
      typo.shouldUseTypo &&
      typo.mode === "quick" &&
      typo.correctionText &&
      !isEmojiOnly(typo.correctionText)
    ) {
      actionsUsedByTool++;
      scheduleQuickTypoCorrection(ctx, state, typo.correctionText);
      return JSON.stringify({
        success: true,
        message_id: sentMessageId,
        actions_used: actionsUsedByTool,
        typo: { mode: "quick", correction: "scheduled" },
      });
    }

    if (typo.shouldUseTypo && typo.mode === "recall") {
      actionsUsedByTool += 2;
      scheduleRecallTypoCorrection({
        ctx,
        state,
        sentMessageId,
        correctedText: text,
        replyToMessageId,
      });
      return JSON.stringify({
        success: true,
        message_id: sentMessageId,
        actions_used: actionsUsedByTool,
        typo: { mode: "recall", correction: "scheduled" },
      });
    }

    return JSON.stringify({
      success: true,
      message_id: sentMessageId,
      actions_used: actionsUsedByTool,
      ...(typo.shouldUseTypo ? { typo: { mode: "ignore" } } : {}),
      ...(typo.rejectedReason ? { typo_rejected: typo.rejectedReason } : {}),
    });
  };
}
