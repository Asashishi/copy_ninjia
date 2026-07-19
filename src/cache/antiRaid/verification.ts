import type { VerificationState } from "../../states/verification";
import { VERIFICATION_REVISION_RETENTION_MS } from "../../consts/antiRaid/verification";

/** 一条验证状态机条目：纯状态 + 解释器持有的活动计时器。 */
export interface VerificationEntry {
  state: VerificationState;
  timer: ReturnType<typeof setTimeout>;
}

/** 以 "chatId:userId" 为键，同一个人在不同群里独立追踪。 */
export const verificationEntries: Map<string, VerificationEntry> = new Map();
/** 当前主线程分配的 Worker 代际；0 表示尚未收到 adoptVerifications。 */
export const verificationGeneration: { current: number } = { current: 0 };
/** 每个 key 在当前代际内最后使用的 revision；终结项只短期保留。 */
export const verificationRevisions: Map<string, { revision: number; retiredAt?: number }> = new Map();

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
