import type { VerificationSnapshot } from "../../types/antiRaid";
import type { VerificationFileChange } from "../../types/diskIO";
import type { DayFileState } from "../../types/diskIO/storage";

/** 待验证按日 append JSON 的 active 镜像、增量、文件游标及两个 timer。 */
export const verificationWorkerCache: Map<string, VerificationSnapshot> = new Map();
export const verificationPendingChanges: Map<string, VerificationFileChange> = new Map();
export const verificationFileState: {
  current: DayFileState | null;
  appendedEntries: number;
  appendedBytes: number;
} = {
  current: null,
  appendedEntries: 0,
  appendedBytes: 0,
};
export const verificationFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
export const verificationRolloverTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

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
