import { userReplyTriggerTimes } from "../../cache/auto";
import { USER_REPLY_TRIGGER_COOLDOWN_MS } from "../../consts/auto";
import type { MessageTriggerContext } from "./triggerContext";

export interface DirectMediaTrigger {
  reason: "reply" | "mention";
  repliedBotText?: string;
}

export interface RandomTriggerConditions {
  directTrigger?: DirectMediaTrigger;
  isQuiet: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  probability: number;
}

/** 文本和三类媒体共用的随机搭话/评价掷骰条件。 */
export function shouldAttemptRandomTrigger(conditions: RandomTriggerConditions): boolean {
  return !conditions.directTrigger &&
    !conditions.isQuiet &&
    !conditions.hasOtherMention &&
    !conditions.repliesToSelf &&
    Math.random() < conditions.probability;
}

/** 三类媒体 handler（photo/sticker/animation）共用的随机评价判定：先掷骰
 *  看这份媒体是否成为解析后评价的候选，命中再占用「群 × 发言人」冷却名额。
 *  两个布尔都要用：candidate 决定 handler 的返回值（是否已接管这条消息），
 *  claimed 决定 recordChatMedia 的 commentOnResolve。 */
export function claimRandomMediaTrigger(context: MessageTriggerContext, speakerId: number): { candidate: boolean; claimed: boolean } {
  const candidate: boolean = shouldAttemptRandomTrigger({
    directTrigger: context.directMediaTrigger,
    isQuiet: context.isQuiet,
    hasOtherMention: context.hasOtherMention,
    repliesToSelf: context.repliesToSelf,
    probability: context.aiReplyProbability,
  });
  return { candidate, claimed: candidate && tryClaimUserReplyTrigger(context.chatId, speakerId) };
}

/**
 * 按「群 × 发言人」占用一次随机回复冷却名额。明确回复或 @ 机器人的直接
 * 交互不经过这里，由 Worker 的有界直接触发队列承接。
 */
export function tryClaimUserReplyTrigger(chatId: number, speakerId: number): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const now: number = Date.now();
  const lastTime: number = userReplyTriggerTimes.get(key) ?? 0;
  if (now - lastTime < USER_REPLY_TRIGGER_COOLDOWN_MS) return false;

  userReplyTriggerTimes.set(key, now);
  setTimeout(() => {
    if (userReplyTriggerTimes.get(key) === now) userReplyTriggerTimes.delete(key);
  }, USER_REPLY_TRIGGER_COOLDOWN_MS).unref();
  return true;
}
