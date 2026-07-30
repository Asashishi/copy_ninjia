import { userReplyTriggerTimes } from "../../cache/main/auto";
import { USER_REPLY_TRIGGER_COOLDOWN_MS } from "../../consts/auto";
import type { AiDirectTriggerReason } from "../../types/aiChat/protocol";
import type { MessageTriggerContext } from "./triggerContext";

export interface DirectTrigger {
  reason: AiDirectTriggerReason;
}

export interface RandomTriggerConditions {
  directTrigger?: DirectTrigger;
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
    directTrigger: context.directTrigger,
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
export function tryClaimUserReplyTrigger(chatId: number, speakerId: number, now: number = Date.now()): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const lastTime: number = userReplyTriggerTimes.get(key) ?? 0;
  // 时钟回拨时旧冷却点位于未来；先失效它，再从新时间轴计时。
  if (lastTime > now) userReplyTriggerTimes.delete(key);
  else if (now - lastTime < USER_REPLY_TRIGGER_COOLDOWN_MS) return false;

  userReplyTriggerTimes.set(key, now);
  setTimeout((): void => {
    if (userReplyTriggerTimes.get(key) === now) userReplyTriggerTimes.delete(key);
  }, USER_REPLY_TRIGGER_COOLDOWN_MS).unref();
  return true;
}
