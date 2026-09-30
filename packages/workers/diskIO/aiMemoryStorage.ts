/**
 * Disk I/O Worker 的 AI 记忆 owner：按 revision 接管快照与删除，把最终值排入共享 SQLite
 * 事务缓冲，由 storageDatabase/flush.ts 与其它表在同一事务内提交。普通快照跟随共享事务的
 * 定时、满批、领域屏障与停机 flush 提交；删除与 purge 后首份快照立即提交，durable 回执在
 * 事务成功后由 storageDatabase/aiContext.ts 发出。
 */

import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryImmediateChats,
  hydrateAiMemoryCache,
  markAiMemoryDeleted,
  markAiMemoryDirty,
} from "../../cache/workers/diskIO/snapshots";
import { noteStorageWriteRejected } from "../../cache/workers/diskIO/storageDatabase";
import { assertAiContextSnapshot, queueAiContextWrite } from "./storageDatabase/aiContext";
import { commitStorageUrgently, scheduleStorageCommit } from "./storageDatabase/flush";

/** 跨域启动第二阶段：全部领域 inspect 成功后按磁盘快照重建水位线，并交出恢复结果（只复制键值引用）。 */
export function adoptAiMemorySnapshots(
  snapshots: ReadonlyMap<number, string>
): Map<number, string> {
  hydrateAiMemoryCache(snapshots);
  return new Map(snapshots);
}

export interface MarkAiMemorySnapshotDirtyParams {
  chatId: number;
  revision: number;
  snapshot: string;
  persistImmediately?: boolean;
}

/**
 * 接管一份快照：先严格校验，非法快照只记 console.error 与 aiMemory 领域拒收标记，不推进
 * revision 水位线、不进入共享事务；迟到 revision 直接忽略。purge 后首份快照登记即时回执并
 * 立即提交。
 */
export function markAiMemorySnapshotDirty({
  chatId,
  revision,
  snapshot,
  persistImmediately = false,
}: MarkAiMemorySnapshotDirtyParams): void {
  try {
    assertAiContextSnapshot(chatId, snapshot);
  } catch (error: unknown) {
    noteStorageWriteRejected("aiMemory");
    console.error(`[diskIOWorker] rejected an invalid AI memory snapshot for chat ${chatId}:`, error);
    return;
  }
  if (!markAiMemoryDirty(chatId, revision)) return;
  queueAiContextWrite(chatId, snapshot, revision);
  if (!persistImmediately) {
    scheduleStorageCommit();
    return;
  }
  aiMemoryImmediateChats.add(chatId);
  commitStorageUrgently();
}

/** 接管一次删除并立即提交；已被更新 revision 覆盖的迟到删除直接回执，不再写库。 */
export function deleteAiMemorySnapshot(chatId: number, revision: number): void {
  if (!markAiMemoryDeleted(chatId, revision)) {
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
    return;
  }
  queueAiContextWrite(chatId, null, revision);
  commitStorageUrgently();
}
