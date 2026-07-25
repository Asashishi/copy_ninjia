import type { VerificationSnapshot } from "../../types/antiRaid";
import type { VerificationFileChange } from "../../types/diskIO";
import type { DayFileState } from "../../types/diskIO/storage";

/**
 * 待验证按日 append JSON 的落盘状态（packages/workers/diskIO/verificationFiles.ts）
 * 的内存状态：active 镜像、增量、文件游标及两个 timer。
 */

/**
 * 待验证记录的当前 active 镜像，key 为 "chatId:userId"。没有独立的 hydrate
 * 函数：Worker 启动/恢复时由 recoverVerificationDay 内联重建——先
 * resetVerificationPersistenceCache 清空，把当天文件逐条解码校验进局部
 * Map，全部通过后才整份灌入本镜像（单条损坏则整个启动过程直接抛错，不留
 * 部分恢复结果）。此后 handleVerificationUpsert/handleVerificationDelete
 * 按验证生命周期增量更新/删除；compactVerificationDay 收敛快照或跨东京日
 * rollover 时会整份重写落盘文件，但不改变本镜像的更新方式。
 */
export const verificationWorkerCache: Map<string, VerificationSnapshot> = new Map();
/** 250ms 合并窗口内每个成员的最新变化；flush 后按 revision 删除。 */
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
/** 东京日期边界的唯一 rollover timer；重排、跨日或 reset 时清除。 */
export const verificationRolloverTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/** Worker 恢复/停止时取消两个 timer 并清空镜像、增量和文件游标。 */
export function resetVerificationPersistenceCache(): void {
  if (verificationFlushTimer.timer !== null) clearTimeout(verificationFlushTimer.timer);
  if (verificationRolloverTimer.timer !== null) clearTimeout(verificationRolloverTimer.timer);
  verificationFlushTimer.timer = null;
  verificationRolloverTimer.timer = null;
  verificationWorkerCache.clear();
  verificationPendingChanges.clear();
  verificationFileState.current = null;
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}
