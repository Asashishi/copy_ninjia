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

/**
 * 发送一段纯文本并登记自录；本轮已作废时不发送并返回 undefined。正文总带触发话题：
 * 不挂回复的正文没有回复关系可以带路，话题群里缺了它就会掉进 General；挂了回复也要带，
 * 回复目标被删时不至于跟着掉出话题。
 * @returns 发出的消息 id；未发送或发送失败时为 undefined。
 */
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
