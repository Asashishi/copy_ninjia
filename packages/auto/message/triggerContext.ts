import type { Message } from "@grammyjs/types";
import { isReplyToSelf, resolveForwardOrigin, resolveMentionFacts, resolveReplyReference, type MentionFacts } from "./facts";
import type { DirectTrigger } from "./triggerPolicy";
import type { AiBotInfo, AiReplyReference } from "../../types/aiChat/protocol";

export interface MessageTriggerContext {
  message: Message;
  chatId: number;
  bot: AiBotInfo;
  isQuiet: boolean;
  aiReplyProbability: number;
  repliedTo?: Message;
  replyReference?: AiReplyReference;
  /** 当前消息本身是转发时的来源标注；非转发省略。 */
  forwardedFrom?: string;
  isMentioned: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  directTrigger?: DirectTrigger;
}

export interface CreateMessageTriggerContextParams {
  message: Message;
  bot: AiBotInfo;
  isQuiet: boolean;
  aiReplyProbability: number;
}

/** 一次计算文本和媒体 handler 共用的直接/随机触发事实。 */
export function createMessageTriggerContext({
  message,
  bot,
  isQuiet,
  aiReplyProbability,
}: CreateMessageTriggerContextParams): MessageTriggerContext {
  const repliedTo: Message | undefined = message.reply_to_message;
  const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === bot.id;
  // 两个提及事实一次遍历解析（见 facts.ts 的 resolveMentionFacts）。
  const mentionFacts: MentionFacts = resolveMentionFacts(message, bot.id, bot.username);
  const directTrigger: DirectTrigger | undefined = isReplyToBot
    ? { reason: "reply" }
    : mentionFacts.isMentioned
    ? { reason: "mention" }
    : undefined;

  return {
    message,
    chatId: message.chat.id,
    bot,
    isQuiet,
    aiReplyProbability,
    repliedTo,
    replyReference: resolveReplyReference(message),
    forwardedFrom: resolveForwardOrigin(message),
    isMentioned: mentionFacts.isMentioned,
    hasOtherMention: mentionFacts.hasOtherMention,
    repliesToSelf: isReplyToSelf(message),
    directTrigger,
  };
}
