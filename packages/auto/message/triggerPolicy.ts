import {
  userReplyTriggerSweepState,
  userReplyTriggerTimes,
} from "../../cache/main/auto";
import {
  USER_REPLY_TRIGGER_CACHE_MAX,
  USER_REPLY_TRIGGER_COOLDOWN_MS,
} from "../../consts/auto";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../types/auto";

/** 文本和各媒体 handler（photo/sticker/animation/voice）共用的随机搭话/评价掷骰条件。 */
export function shouldAttemptRandomTrigger(context: MessageTriggerContext): boolean {
  return context.directTriggerReason === undefined &&
    !context.isQuiet &&
    !context.hasOtherMention &&
    !context.repliesToSelf &&
    Math.random() < context.aiReplyProbability;
}

/**
 * 各媒体 handler（photo/sticker/animation/voice）共用的随机评价判定：先掷骰
 * 看这份媒体是否成为解析后评价的候选，命中再占用「群 × 发言人」冷却名额。
 *
 * 返回值的两级用法：`!== "none"` 决定 handler 的返回值（是否已接管这条消息），
 * `=== "claimed"` 经 recordContext.ts 的 mediaReplyBackpressurePlaceholder 决定媒体
 * 是否发起回复轮。取值见 types/auto.ts 的 RandomMediaTrigger。
 */
export function claimRandomMediaTrigger(
  context: MessageTriggerContext,
  speakerId: number
): RandomMediaTrigger {
  if (!shouldAttemptRandomTrigger(context)) return "none";
  return tryClaimUserReplyTrigger(context.chatId, speakerId, context.now)
    ? "claimed"
    : "candidate";
}

/**
 * 媒体 handler（photo/animation/voice/sticker）是否已经接管这条消息（不再往下走复读/主动行为）：
 * 直接回复或 @ 机器人一定接管；否则只有随机触发成立（`claimed` 或
 * `candidate`，见 claimRandomMediaTrigger）才算接管。
 * 解析不出可用媒体而走 replyToUnresolvableMedia 的分支不经过本函数。
 */
export function mediaTriggerHandled(
  context: MessageTriggerContext,
  randomTrigger: RandomMediaTrigger
): boolean {
  return context.directTriggerReason !== undefined || randomTrigger !== "none";
}

/**
 * 删除已到期或因系统时钟回拨落到未来的冷却，并重算满表有效区间。统一 timer 与容量边界共用；
 * 导出供边界测试。
 */
export function sweepUserReplyTriggerTimes(now: number = Date.now()): void {
  let earliest: number = Number.POSITIVE_INFINITY;
  for (const [chatId, users] of userReplyTriggerTimes) {
    for (const [userId, claimedAt] of users) {
      if (
        claimedAt > now ||
        now - claimedAt >= USER_REPLY_TRIGGER_COOLDOWN_MS
      ) {
        users.delete(userId);
        userReplyTriggerSweepState.size--;
      } else if (claimedAt < earliest) {
        earliest = claimedAt;
      }
    }
    if (users.size === 0) userReplyTriggerTimes.delete(chatId);
  }
  userReplyTriggerSweepState.validFrom = now;
  userReplyTriggerSweepState.validUntil = userReplyTriggerSweepState.size >= USER_REPLY_TRIGGER_CACHE_MAX
    ? earliest + USER_REPLY_TRIGGER_COOLDOWN_MS
    : Number.NEGATIVE_INFINITY;
}

/** 只为整张冷却表安排一个最早到期清扫。 */
function scheduleUserReplyTriggerSweep(now: number): void {
  if (
    userReplyTriggerSweepState.timer !== null ||
    userReplyTriggerSweepState.size === 0
  ) {
    return;
  }
  let earliestExpiry: number = Number.POSITIVE_INFINITY;
  for (const users of userReplyTriggerTimes.values()) {
    for (const claimedAt of users.values()) {
      earliestExpiry = Math.min(
        earliestExpiry,
        claimedAt + USER_REPLY_TRIGGER_COOLDOWN_MS
      );
    }
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
 * 交互不经过这里，由 Worker 侧的直接触发队列承接。
 */
export function tryClaimUserReplyTrigger(chatId: number, speakerId: number, now: number = Date.now()): boolean {
  let users: Map<number, number> | undefined = userReplyTriggerTimes.get(chatId);
  const lastTime: number | undefined = users?.get(speakerId);
  // 时钟回拨时旧冷却点位于未来，先失效它，再从新时间轴计时。
  if (lastTime !== undefined) {
    if (lastTime <= now && now - lastTime < USER_REPLY_TRIGGER_COOLDOWN_MS) return false;
    users!.delete(speakerId);
    userReplyTriggerSweepState.size--;
    // 满表中的条目已换代，旧有效区间失效。
    if (userReplyTriggerSweepState.size === USER_REPLY_TRIGGER_CACHE_MAX - 1) {
      userReplyTriggerSweepState.validUntil = Number.NEGATIVE_INFINITY;
    }
  }

  // 正常到期由唯一 timer 清理；逼近硬顶时在热路径补扫一次，补扫后仍满说明
  // 所有现存冷却都有效，fail closed 放弃本次随机回复。
  if (userReplyTriggerSweepState.size >= USER_REPLY_TRIGGER_CACHE_MAX) {
    if (now >= userReplyTriggerSweepState.validFrom && now < userReplyTriggerSweepState.validUntil) return false;
    sweepUserReplyTriggerTimes(now);
    if (userReplyTriggerSweepState.size >= USER_REPLY_TRIGGER_CACHE_MAX) return false;
    users = userReplyTriggerTimes.get(chatId);
  }

  if (users === undefined) {
    users = new Map();
    userReplyTriggerTimes.set(chatId, users);
  }
  users.set(speakerId, now);
  userReplyTriggerSweepState.size++;
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
  userReplyTriggerSweepState.size = 0;
  userReplyTriggerSweepState.validUntil = Number.NEGATIVE_INFINITY;
}
