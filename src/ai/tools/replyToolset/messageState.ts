import { sendMessageWithResult } from "../../../infra/telegram";
import type { ReplyToolContext } from "../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../types/telegram";

export interface RoundMessageState {
  messageCount: number;
  typoUsedThisRound: boolean;
  sentCanonicalTexts: Map<number, string>;
  /** 执行侧已接管的错字纠正单字；防止模型从工具结果自行补发。 */
  reservedCorrectionText: string | null;
}

export function createRoundMessageState(): RoundMessageState {
  return {
    messageCount: 0,
    typoUsedThisRound: false,
    sentCanonicalTexts: new Map<number, string>(),
    reservedCorrectionText: null,
  };
}

export function isDuplicateOfSentMessage(state: RoundMessageState, text: string): boolean {
  if (state.reservedCorrectionText === text) return true;
  for (const sentText of state.sentCanonicalTexts.values()) {
    if (sentText === text) return true;
  }
  return false;
}

export interface RecordSentMessageParams {
  ctx: ReplyToolContext;
  state: RoundMessageState;
  text: string;
  messageId: number;
  /** 这次发送实际挂上的回复目标；没挂回复时省略（见 ReplyToolContext.onMessageSent）。 */
  repliedToMessageId?: number;
}

export interface SendDirectMessageParams {
  ctx: ReplyToolContext;
  state: RoundMessageState;
  text: string;
  replyToMessageId?: number;
}

export function recordSentMessage({ ctx, state, text, messageId, repliedToMessageId }: RecordSentMessageParams): void {
  state.messageCount++;
  ctx.onMessageSent(text, messageId, repliedToMessageId);
}

export async function sendDirectMessage({
  ctx,
  state,
  text,
  replyToMessageId,
}: SendDirectMessageParams): Promise<number | undefined> {
  if (!ctx.isActive()) return undefined;
  const sent: TelegramSendResult | undefined = await sendMessageWithResult({
    chatId: ctx.chatId,
    text,
    replyToMessageId,
  });
  if (sent !== undefined) {
    recordSentMessage({
      ctx,
      state,
      text,
      messageId: sent.messageId,
      ...(sent.repliedToMessageId !== undefined ? { repliedToMessageId: sent.repliedToMessageId } : {}),
    });
  }
  return sent?.messageId;
}
