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

/** 登记本轮已接纳的正文或媒体附言；按归一化形态入集合。 */
export function acceptRoundText(state: RoundMessageState, text: string): void {
  state.acceptedCanonicalTexts.add(canonicalReplyText(text));
}

/** 登记执行侧接管的错字纠正字；按归一化形态保存。 */
export function reserveCorrectionText(state: RoundMessageState, text: string): void {
  state.reservedCorrectionText = canonicalReplyText(text);
}

/** 同轮已接纳或发送的正文、媒体附言与执行侧接管的纠正字共用判重边界。 */
export function isDuplicateOfAcceptedText(state: RoundMessageState, text: string): boolean {
  const canonical: string = canonicalReplyText(text);
  return state.reservedCorrectionText === canonical || state.acceptedCanonicalTexts.has(canonical);
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
