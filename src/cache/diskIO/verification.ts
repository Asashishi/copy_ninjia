import type { VerificationSnapshot } from "../../types/antiRaid";
import type { VerificationFileChange } from "../../types/diskIO";
import type { DayFileState } from "../../types/diskIO/storage";

/** 待验证按日 append JSON 的 active 镜像、增量、文件游标及两个 timer。 */
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
