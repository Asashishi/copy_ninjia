import { sendMessageWithResult } from "../../../../infra/telegram";
import type {
  ReplyToolContext,
  RoundMessageState,
} from "../../../../types/aiChat/replies";
import type { TelegramSendResult } from "../../../../types/telegram";

export function createRoundMessageState(): RoundMessageState {
  return {
    typoUsedThisRound: false,
    acceptedCanonicalTexts: new Set<string>(),
    reservedCorrectionText: null,
  };
}

/** 比较用的文本归一化；保留字词、大小写和标点，只合并空白与 Unicode 等价编码。 */
function canonicalReplyText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** 同轮已接纳或发送的正文、媒体附言与执行侧接管的纠正字共用判重边界。 */
export function isDuplicateOfAcceptedText(state: RoundMessageState, text: string): boolean {
  const canonical: string = canonicalReplyText(text);
  if (state.reservedCorrectionText !== null && canonicalReplyText(state.reservedCorrectionText) === canonical) return true;
  for (const acceptedText of state.acceptedCanonicalTexts) {
    if (canonicalReplyText(acceptedText) === canonical) return true;
  }
  return false;
}

export interface SendDirectMessageParams {
  ctx: ReplyToolContext;
  text: string;
  replyToMessageId?: number;
}

export async function sendDirectMessage({
  ctx,
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
    ctx.onMessageSent(text, sent.messageId, sent.repliedToMessageId);
  }
  return sent?.messageId;
}
