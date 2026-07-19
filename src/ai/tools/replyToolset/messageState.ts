import { sendMessage } from "../../../infra/telegram";
import type { ReplyToolContext } from "../../../types/aiChat/replies";

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

interface RecordSentMessageParams {
  ctx: ReplyToolContext;
  state: RoundMessageState;
  text: string;
  messageId: number;
}

interface SendDirectMessageParams {
  ctx: ReplyToolContext;
  state: RoundMessageState;
  text: string;
  replyToMessageId?: number;
}

export function recordSentMessage({ ctx, state, text, messageId }: RecordSentMessageParams): void {
  state.messageCount++;
  ctx.onMessageSent(text, messageId);
}

export async function sendDirectMessage({
  ctx,
  state,
  text,
  replyToMessageId,
}: SendDirectMessageParams): Promise<number | undefined> {
  if (!ctx.isActive()) return undefined;
  const sentMessageId: number | undefined = await sendMessage({
    chatId: ctx.chatId,
    text,
    replyToMessageId,
  });
  if (sentMessageId !== undefined) recordSentMessage({ ctx, state, text, messageId: sentMessageId });
  return sentMessageId;
}
