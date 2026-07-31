import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { SELF_ACTION_TAG_MARKERS, SELF_ACTION_TAG_PATTERNS } from "../../../../consts/aiChat/prompts/transcript";
import { toolError } from "../../utils/toolResult";
import { pauseForToolAction } from "../../utils/toolPause";
import { sendMessageWithResult } from "../../../../infra/telegram";
import type { ReplyToolContext } from "../../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../../types/telegram";
import { isEmojiOnly } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { parseBooleanField } from "../../utils/toolArgs";
import {
  isDuplicateOfSentMessage,
  recordSentMessage,
} from "./messageState";
import {
  applyQuickTypoCorrection,
  decideMessageTypo,
  parseCleanMessageText,
} from "./typoHandling";
import type { RoundMessageState } from "../../../../types/aiChat/replies";
import type { TypoDecision } from "../../../../types/aiChat/typo";

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
    // 转录里那些「（发了一枚贴纸：…）」「（…生成并发送了一张图片：…）」的行是执行侧
    // 在动作真正落地之后写的凭据，模型只该读到。生图撞上群冷却时它有概率不说
    // 「发不了」，而是照着见过的形状打一段出来——群友收到一条声称配了图、实际
    // 什么都没有的消息，记忆里还会留下一条假的动作记录，下一轮它自己也会当真。
    // 提示词那边已经写了禁令，但那是概率性的，这里做成硬拦截。
    // 匹配的是模板的完整形状而不是裸短语——那两个短语本身是日常中文，群友
    // 直接问起时模型照常作答不该被当成伪造（见 SELF_ACTION_TAG_PATTERNS）。
    const forgedIndex: number = SELF_ACTION_TAG_PATTERNS.findIndex(
      (pattern: RegExp): boolean => pattern.test(text)
    );
    if (forgedIndex >= 0) {
      const forgedMarker: string = SELF_ACTION_TAG_MARKERS[forgedIndex] ?? "";
      return toolError(
        `Text must not narrate an action: "${forgedMarker}" is a transcript marker the execution side writes after the action really happened. ` +
        "Perform the action with its own tool (send_sticker / generate_image), or, if it is unavailable, say so plainly in your own words",
        { retryable: false }
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
    const invalidated: string | null = await pauseForToolAction({
      delayMs: typingDelayMs(typo.textToSend),
      signal: ctx.signal,
    });
    if (invalidated !== null) return invalidated;
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
      signal: ctx.signal,
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
