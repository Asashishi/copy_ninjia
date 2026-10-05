/** owner: workers/antiRaid。入群验证状态机（packages/workers/antiRaid/verificationRuntime.ts）的内存状态。 */

import { VERIFICATION_REVISION_CAPACITY, VERIFICATION_REVISION_RETENTION_MS } from "../../../consts/antiRaid/verification";
import type {
  ReminderDelivery,
  ThreadCommentConfirmation,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { DeferredVerificationRecord } from
  "../../../types/antiRaid/verification";

/**
 * 以 "chatId:userId" 为键，同一个人在不同群里独立追踪。
 *
 * 填充：状态机每次转移到非 ABSENT 状态时写入（入群、秒踢、终态接管）。
 * 清理：转移回 ABSENT（验证通过、离群、终态结算完成、守卫关闭）时按 key 删除，
 * adopt 换代际时整表清空并重建。全部运行态共用 VERIFICATION_RUNTIME_CAPACITY，
 * 满额拒收新 key、报告一次 fatal，已有条目继续更新和解除；恢复优先接管持久责任，
 * 必要时只释放 exempt/kicked 去重并锁住新 key 准入。持久阶段另受主线程与 Disk I/O
 * 的 VERIFICATION_RECORD_CAPACITY 约束，运行态不淘汰持久责任。
 * Worker 崩溃重建：主线程 adopt 全量重放，见 states/verification/adopt.ts。
 */
export const verificationEntries: Map<string, VerificationEntry> = new Map();
/**
 * 运行态满额的拒收闩锁；首次超限置 true 并报告 fatal，已有 key 不受影响。
 * 容量固定一个布尔值；仅下一代 adopt 或 stop 复位，释放去重或 TTL 到期不复位。
 * Worker 崩溃后新 isolate 为 false，由持久镜像重建当前责任。
 */
export const verificationRuntimeCapacityFatalState: { current: boolean } = { current: false };
/** 当前主线程分配的 Worker 代际；0 表示尚未收到 adoptVerifications。 */
export const verificationGeneration: { current: number } = { current: 0 };
/**
 * 每个 key 在当前代际内最后使用的 revision；终结项只短期保留。
 *
 * 填充：每次发布快照或接管 adopt 记录时更新。清理：终结项标记 retiredAt 后由
 * sweepVerificationRevisionCache 按 VERIFICATION_REVISION_RETENTION_MS 回收，
 * adopt 换代际时整表清空。容量上限为 VERIFICATION_REVISION_CAPACITY，满额拒收
 * 新 key 并请求主线程按 fatal 边界停机；未过期墓碑不淘汰。Worker 崩溃后由
 * 主线程重放活跃与延后记录；旧代际墓碑不重放，迟到消息由代际过滤。
 */
export const verificationRevisions: Map<string, { revision: number; retiredAt?: number }> = new Map();
/** revision 容量 fatal 每代际只发一次；换代际或停止时清零，满额后的新 key 不接管。 */
export const verificationRevisionCapacityFatalState: { current: boolean } = { current: false };

/** 新 revision key 满额时先扫过期墓碑；已有 key 的更新和终结始终允许。 */
export function canAdmitVerificationRevision(key: string): boolean {
  if (verificationRevisions.size < VERIFICATION_REVISION_CAPACITY) return true;
  if (verificationRevisions.has(key)) return true;
  sweepVerificationRevisionCache();
  return verificationRevisions.size < VERIFICATION_REVISION_CAPACITY;
}

/**
 * 主线程在 adopt 时全量推送的本进程延后索引；预算耗尽
 * 或 adopt 时填充，明确离群、功能关闭、群停管或 Worker 停止时清理。主线程是
 * 权威，Worker 崩溃后由主线程全量重放；容量不超过主线程延后索引，缺少条目表示
 * 本 isolate 未接管该延后闩锁，不得沿用旧代际结论。
 */
export const deferredVerificationRecords: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * 冷缓存楼中楼消息的在途关联频道确认。每个成员键只有一个可更新 owner，请求
 * settle、群停用、Worker adopt 或停止时清除；Worker 崩溃后不恢复，重新观察
 * 消息后再建。全局容量由 THREAD_COMMENT_CONFIRMATION_MAX 背压限制：满载时拒收
 * 新的确认请求，不淘汰在途项——被淘汰的那一项会让一名已确认参与讨论的成员被踢。
 */
export const threadCommentConfirmations: Map<string, ThreadCommentConfirmation> =
  new Map();

/**
 * 每名 pending 成员唯一的提醒发送 owner。状态替换、发送落地、群停用、
 * adopt 或 Worker 停止时清除；崩溃后由持久化 pending 快照重新安排。
 * 容量：pending 状态的成员数，是 verificationEntries 的子集，不单独设淘汰。
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
