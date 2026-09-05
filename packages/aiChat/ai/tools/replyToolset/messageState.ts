import { sendMessageWithResult } from "../../../../infra/telegram";
import type {
  ReplyToolContext,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../../types/telegram";

export function createRoundMessageState(): RoundMessageState {
  return {
    messageCount: 0,
    typoUsedThisRound: false,
    sentCanonicalTexts: new Map<number, string>(),
    reservedCorrectionText: null,
  };
}

/** 比较用的文本归一化；保留字词、大小写和标点，只合并空白与 Unicode 等价编码。 */
function canonicalReplyText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** 同轮已发送的正文、媒体附言与执行侧接管的纠正字共用判重边界。 */
export function isDuplicateOfSentMessage(state: RoundMessageState, text: string): boolean {
  const canonical: string = canonicalReplyText(text);
  if (state.reservedCorrectionText !== null && canonicalReplyText(state.reservedCorrectionText) === canonical) return true;
  for (const sentText of state.sentCanonicalTexts.values()) {
    if (canonicalReplyText(sentText) === canonical) return true;
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
    signal: ctx.signal,
    messageThreadId: ctx.messageThreadId,
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
