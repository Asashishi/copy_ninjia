import {
  userReplyTriggerSweepState,
  userReplyTriggerTimes,
} from "../../cache/main/auto";
import {
  USER_REPLY_TRIGGER_CACHE_MAX,
  USER_REPLY_TRIGGER_COOLDOWN_MS,
} from "../../consts/auto";
import type { MessageTriggerContext } from "../../types/auto";

/** 文本和三类媒体共用的随机搭话/评价掷骰条件。 */
export function shouldAttemptRandomTrigger(context: MessageTriggerContext): boolean {
  return !context.directTrigger &&
    !context.isQuiet &&
    !context.hasOtherMention &&
    !context.repliesToSelf &&
    Math.random() < context.aiReplyProbability;
}

/** 三类媒体 handler（photo/sticker/animation）共用的随机评价判定：先掷骰
 *  看这份媒体是否成为解析后评价的候选，命中再占用「群 × 发言人」冷却名额。
 *  两个布尔都要用：candidate 决定 handler 的返回值（是否已接管这条消息），
 *  claimed 决定 recordChatMedia 的 commentOnResolve。 */
export function claimRandomMediaTrigger(context: MessageTriggerContext, speakerId: number): { candidate: boolean; claimed: boolean } {
  const candidate: boolean = shouldAttemptRandomTrigger(context);
  return { candidate, claimed: candidate && tryClaimUserReplyTrigger(context.chatId, speakerId) };
}

/**
 * 删除已到期或因系统时钟回拨落到未来的冷却。统一 timer 与容量边界共用，
 * 导出以便验证精确到期和异常时间轴。
 */
export function sweepUserReplyTriggerTimes(now: number = Date.now()): void {
  for (const [key, claimedAt] of userReplyTriggerTimes) {
    if (
      claimedAt > now ||
      now - claimedAt >= USER_REPLY_TRIGGER_COOLDOWN_MS
    ) {
      userReplyTriggerTimes.delete(key);
    }
  }
}

/** 只为整张冷却表安排一个最早到期清扫。 */
function scheduleUserReplyTriggerSweep(now: number): void {
  if (
    userReplyTriggerSweepState.timer !== null ||
    userReplyTriggerTimes.size === 0
  ) {
    return;
  }
  let earliestExpiry: number = Number.POSITIVE_INFINITY;
  for (const claimedAt of userReplyTriggerTimes.values()) {
    earliestExpiry = Math.min(
      earliestExpiry,
      claimedAt + USER_REPLY_TRIGGER_COOLDOWN_MS
    );
  }
  if (!Number.isFinite(earliestExpiry)) return;
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    userReplyTriggerSweepState.timer = null;
    const currentTime: number = Date.now();
    sweepUserReplyTriggerTimes(currentTime);
    scheduleUserReplyTriggerSweep(currentTime);
  }, Math.max(1, earliestExpiry - now));
  timer.unref();
  userReplyTriggerSweepState.timer = timer;
}

/**
 * 按「群 × 发言人」占用一次随机回复冷却名额。明确回复或 @ 机器人的直接
 * 交互不经过这里，由 Worker 的有界直接触发队列承接。
 */
export function tryClaimUserReplyTrigger(chatId: number, speakerId: number, now: number = Date.now()): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const lastTime: number | undefined = userReplyTriggerTimes.get(key);
  // 时钟回拨时旧冷却点位于未来；先失效它，再从新时间轴计时。
  if (lastTime !== undefined) {
    if (lastTime > now) userReplyTriggerTimes.delete(key);
    else if (now - lastTime < USER_REPLY_TRIGGER_COOLDOWN_MS) return false;
    else userReplyTriggerTimes.delete(key);
  }

  // 正常到期由唯一 timer 清理；只有逼近硬顶时在热路径补扫一次，避免每次
  // 随机命中都 O(n)。仍满说明所有现存冷却都有效，fail closed 放弃本次随机回复。
  if (userReplyTriggerTimes.size >= USER_REPLY_TRIGGER_CACHE_MAX) {
    sweepUserReplyTriggerTimes(now);
    if (userReplyTriggerTimes.size >= USER_REPLY_TRIGGER_CACHE_MAX) return false;
  }

  userReplyTriggerTimes.set(key, now);
  scheduleUserReplyTriggerSweep(now);
  return true;
}

/** 清理冷却表与唯一 timer；生产进程退出自然回收，导出用于测试隔离。 */
export function clearUserReplyTriggerTimes(): void {
  if (userReplyTriggerSweepState.timer !== null) {
    clearTimeout(userReplyTriggerSweepState.timer);
    userReplyTriggerSweepState.timer = null;
  }
  userReplyTriggerTimes.clear();
}
