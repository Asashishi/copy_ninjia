import { VERIFICATION_REVISION_RETENTION_MS } from "../../consts/antiRaid/verification";
import type { ReminderDelivery, ThreadCommentConfirmation } from "../../types/antiRaid/internal";
import type { VerificationState } from "../../types/states/verification";

/** 入群验证状态机（packages/workers/antiRaid/verificationRuntime.ts）的内存状态。 */

/** 一条验证状态机条目：纯状态 + 解释器持有的活动计时器。 */
export interface VerificationEntry {
  state: VerificationState;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** 以 "chatId:userId" 为键，同一个人在不同群里独立追踪。 */
export const verificationEntries: Map<string, VerificationEntry> = new Map();
/** 当前主线程分配的 Worker 代际；0 表示尚未收到 adoptVerifications。 */
export const verificationGeneration: { current: number } = { current: 0 };
/** 每个 key 在当前代际内最后使用的 revision；终结项只短期保留。 */
export const verificationRevisions: Map<string, { revision: number; retiredAt?: number }> = new Map();

/**
 * 冷缓存楼中楼消息的在途关联频道确认。消息到达时填充，请求 settle、群停用、
 * Worker adopt 或停止时清除；Worker 崩溃后不恢复，重新观察消息后再建。
 */
export const threadCommentConfirmations: Map<string, Set<ThreadCommentConfirmation>> = new Map();

/**
 * 每名 pending 成员唯一的提醒发送 owner。状态替换、发送落地、群停用、
 * adopt 或 Worker 停止时清除；崩溃后由持久化 pending 快照重新安排。
 */
export const reminderDeliveries: Map<string, ReminderDelivery> = new Map();

/** 删除超过防迟到保留期的终结 revision。 */
export function sweepVerificationRevisionCache(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const [key, revision] of verificationRevisions) {
    if (revision.retiredAt !== undefined && now - revision.retiredAt > VERIFICATION_REVISION_RETENTION_MS) {
      verificationRevisions.delete(key);
      deleted++;
    }
  }
  return deleted;
}
