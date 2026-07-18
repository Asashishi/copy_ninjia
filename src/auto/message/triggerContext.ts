import type { Message } from "@grammyjs/types";
import { isBotMentioned, isReplyToSelf, mentionsOtherUser } from "./facts";
import type { DirectMediaTrigger } from "./triggerPolicy";

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
  isReplyToBot: boolean;
  isMentioned: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  directMediaTrigger?: DirectMediaTrigger;
}

/** 一次计算文本和媒体 handler 共用的直接/随机触发事实。 */
export function createMessageTriggerContext(
  message: Message,
  bot: BotIdentity,
  isQuiet: boolean,
  aiReplyProbability: number
): MessageTriggerContext {
  const repliedTo: Message | undefined = message.reply_to_message;
  const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === bot.id;
  const isMentioned: boolean = isBotMentioned(message, bot.username);
  const directMediaTrigger: DirectMediaTrigger | undefined = isReplyToBot
    ? { reason: "reply", repliedBotText: repliedTo?.text }
    : isMentioned
    ? { reason: "mention" }
    : undefined;

  return {
    message,
    chatId: message.chat.id,
    bot,
    isQuiet,
    aiReplyProbability,
    repliedTo,
    isReplyToBot,
    isMentioned,
    hasOtherMention: mentionsOtherUser(message, bot.id, bot.username),
    repliesToSelf: isReplyToSelf(message),
    directMediaTrigger,
  };
}
