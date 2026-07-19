import { sendMessage } from "../../../infra/telegram";
import type { ReplyToolContext } from "../../../types/aiChat/replies";

export interface RoundMessageState {
  messageCount: number;
  typoUsedThisRound: boolean;
  deletableMessageIds: Set<number>;
  sentCanonicalTexts: Map<number, string>;
  pendingCorrectionText: string | null;
}

export function createRoundMessageState(): RoundMessageState {
  return {
    messageCount: 0,
    typoUsedThisRound: false,
    deletableMessageIds: new Set<number>(),
    sentCanonicalTexts: new Map<number, string>(),
    pendingCorrectionText: null,
  };
}

export function isDuplicateOfSentMessage(state: RoundMessageState, text: string): boolean {
  if (state.pendingCorrectionText === text) return true;
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
  allowInactive?: boolean;
}

export function recordSentMessage({ ctx, state, text, messageId }: RecordSentMessageParams): void {
  state.messageCount++;
  state.deletableMessageIds.add(messageId);
  ctx.onMessageSent(text, messageId);
}

export async function sendDirectMessage({
  ctx,
  state,
  text,
  replyToMessageId,
  allowInactive = false,
}: SendDirectMessageParams): Promise<number | undefined> {
  if (!allowInactive && !ctx.isActive()) return undefined;
  const sentMessageId: number | undefined = await sendMessage({
    chatId: ctx.chatId,
    text,
    replyToMessageId,
  });
  if (sentMessageId !== undefined) recordSentMessage({ ctx, state, text, messageId: sentMessageId });
  return sentMessageId;
}

export function forgetSentMessage(state: RoundMessageState, messageId: number): void {
  state.deletableMessageIds.delete(messageId);
  state.sentCanonicalTexts.delete(messageId);
  state.messageCount = Math.max(0, state.messageCount - 1);
}
