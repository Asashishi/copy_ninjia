import type { Message } from "grammy/types";
import { isReplyToSelf, resolveForwardOrigin, resolveMentionFacts, resolveReplyReference } from "./facts";
import { forumTopicThreadId } from "../../libs/forumTopic";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type { MentionFacts, MessageTriggerContext } from "../../types/auto";
import type { AiDirectTriggerReason } from "../../types/aiChat/protocol";

export interface CreateMessageTriggerContextParams {
  message: Message;
  bot: AiBotInfo;
  /** 本条消息统一的「现在」；见 types/auto.ts 的 MessageTriggerContext.now。 */
  now: number;
  isQuiet: boolean;
  aiReplyProbability: number;
}

/** 一次计算文本和媒体 handler 共用的直接/随机触发事实。 */
export function createMessageTriggerContext({
  message,
  bot,
  now,
  isQuiet,
  aiReplyProbability,
}: CreateMessageTriggerContextParams): MessageTriggerContext {
  const repliedTo: Message | undefined = message.reply_to_message;
  const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === bot.id;
  // 两个提及事实一次遍历解析（见 facts.ts 的 resolveMentionFacts）。
  const mentionFacts: MentionFacts = resolveMentionFacts(message, bot.id, bot.username);
  const directTriggerReason: AiDirectTriggerReason | undefined = isReplyToBot
    ? "reply"
    : mentionFacts.isMentioned
    ? "mention"
    : undefined;

  return {
    message,
    chatId: message.chat.id,
    now,
    bot,
    isQuiet,
    aiReplyProbability,
    repliedTo,
    replyReference: resolveReplyReference(message),
    forwardedFrom: resolveForwardOrigin(message),
    isMentioned: mentionFacts.isMentioned,
    hasOtherMention: mentionFacts.hasOtherMention,
    repliesToSelf: isReplyToSelf(message),
    directTriggerReason,
    messageThreadId: forumTopicThreadId(message),
  };
}
