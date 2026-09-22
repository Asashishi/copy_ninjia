import type { VerificationSnapshot } from
  "../../../types/antiRaid/verification";
import type { VerificationFileChange } from "../../../types/diskIO/messages";
import type { DayFileState } from "../../../types/diskIO/storage";

/**
 * 待验证按日 append JSON 的落盘状态（packages/workers/diskIO/verificationWrites.ts）
 * 的内存状态：active 镜像、增量、文件游标、短合并 timer 与轮换失败重试 timer。
 */

/**
 * 待验证记录的当前 active 镜像，key 为 "chatId:userId"。Worker 启动时先由
 * inspectVerificationDay 只读解码并合并最新旧日与当天文件，所有持久化域
 * 均通过后再由 adoptVerificationDay 清空并整份灌入本镜像；单条损坏会让
 * 整个启动过程直接失败，不留部分恢复结果。此后
 * handleVerificationUpsert/handleVerificationDelete
 * 按验证生命周期增量更新/删除；compactVerificationDay 收敛快照或跨东京日
 * rollover 时会整份重写落盘文件，但不改变本镜像的更新方式。
 *
 * 清理：handleVerificationDelete 单条删除（验证通过、离群、终态结算完成），
 * 跨日 rollover 按最新旧日重建，resetVerificationPersistenceCache 整表清空。
 * 容量：硬顶 VERIFICATION_RECORD_CAPACITY（见 consts/antiRaid/verification.ts），
 * 满载时拒收新记录而不是淘汰旧记录——被淘汰的那条正是还欠一次踢人的。
 * Worker 崩溃重建：由 inspectVerificationDay + adoptVerificationDay 从当天与
 * 最新旧日文件整份重建。
 */
export const verificationWorkerCache: Map<string, VerificationSnapshot> = new Map();
/**
 * 250ms 合并窗口内每个成员的最新变化；flush 后按 revision 删除，
 * resetVerificationPersistenceCache 整表清空。容量：一个合并窗口内发生变化的
 * 成员数，上界同 verificationWorkerCache。Worker 崩溃重建：不重放——未落盘的
 * 那一批由主线程按未 ACK revision 重投。
 */
export const verificationPendingChanges: Map<string, VerificationFileChange> = new Map();
/** 当前东京日追加文件的游标与收敛计数；跨日、恢复或 reset 时重建。 */
export const verificationFileState: {
  current: DayFileState | null;
  appendedEntries: number;
  appendedBytes: number;
} = {
  current: null,
  appendedEntries: 0,
  appendedBytes: 0,
};
/** 普通验证变化的短合并 timer；flush/reset 时清除。 */
export const verificationFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
/** 午夜轮换失败后的唯一重试 timer；成功、重新维护或 reset 时清除。 */
export const verificationRolloverRetryTimer: {
  timer: ReturnType<typeof setTimeout> | null;
} = { timer: null };

/** Worker 恢复/停止时取消两个 timer 并清空镜像、增量和文件游标。 */
export function resetVerificationPersistenceCache(): void {
  if (verificationFlushTimer.timer !== null) clearTimeout(verificationFlushTimer.timer);
  if (verificationRolloverRetryTimer.timer !== null) {
    clearTimeout(verificationRolloverRetryTimer.timer);
  }
  verificationFlushTimer.timer = null;
  verificationRolloverRetryTimer.timer = null;
  verificationWorkerCache.clear();
  verificationPendingChanges.clear();
  verificationFileState.current = null;
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}
