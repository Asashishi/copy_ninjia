import type { Message } from "@grammyjs/types";
import { isReplyToSelf, resolveMentionFacts, resolveReplyReference, type MentionFacts } from "./facts";
import type { DirectTrigger } from "./triggerPolicy";
import type { AiReplyReference } from "../../types/aiChat/protocol";

export interface BotIdentity {
  id: number;
  firstName: string;
  username: string;
}

export interface MessageTriggerContext {
  message: Message;
  chatId: number;
  bot: BotIdentity;
  isQuiet: boolean;
  aiReplyProbability: number;
  repliedTo?: Message;
  replyReference?: AiReplyReference;
  isMentioned: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  directTrigger?: DirectTrigger;
}

interface CreateMessageTriggerContextParams {
  message: Message;
  bot: BotIdentity;
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
    isMentioned: mentionFacts.isMentioned,
    hasOtherMention: mentionFacts.hasOtherMention,
    repliesToSelf: isReplyToSelf(message),
    directTrigger,
  };
}
