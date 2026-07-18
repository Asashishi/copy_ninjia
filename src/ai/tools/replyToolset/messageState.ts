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

export function recordSentMessage(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  text: string,
  messageId: number
): void {
  state.messageCount++;
  state.deletableMessageIds.add(messageId);
  ctx.onMessageSent(text, messageId);
}

export async function sendDirectMessage(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  text: string,
  replyToMessageId?: number,
  allowInactive: boolean = false
): Promise<number | undefined> {
  if (!allowInactive && !ctx.isActive()) return undefined;
  const sentMessageId: number | undefined = await sendMessage(ctx.chatId, text, replyToMessageId);
  if (sentMessageId !== undefined) recordSentMessage(ctx, state, text, sentMessageId);
  return sentMessageId;
}

export function forgetSentMessage(state: RoundMessageState, messageId: number): void {
  state.deletableMessageIds.delete(messageId);
  state.sentCanonicalTexts.delete(messageId);
  state.messageCount = Math.max(0, state.messageCount - 1);
}
