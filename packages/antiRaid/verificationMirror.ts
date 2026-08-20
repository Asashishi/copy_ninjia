import { antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  terminalVerificationAttempts,
  verificationCapacityFatalState,
} from "../cache/main/antiRaid/verificationMirror";
import { VERIFICATION_RECORD_CAPACITY } from "../consts/antiRaid/verification";
import { verificationKey } from "../libs/verificationKey";
import { postDiskIO } from "../infra/diskIO";
import { signalBusinessWorkerFatal } from "../infra/workerSupervisor";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../types/antiRaid/verification";
import type {
  VerificationDeleteEvent,
  VerificationUpsertEvent,
} from "../types/antiRaid/events";

/**
 * 同代际的 revision 水位线；**旧代际的条目一律记 0**。
 *
 * revision 只在一个代际内部单调递增：Worker 崩溃重建时 adoptVerifications 按
 * activeVerificationSnapshots 重放，已删除的 key 不在重放范围内，因此那个 key
 * 的新记录会从 revision 1 重新开始。此时若拿旧代际留下的墓碑（比如 revision 13）
 * 当水位线，新代际的 revision 1 就会被判成过期而 `return false`：记录永远不落盘、
 * terminalPersisted 永远不投递，kickPending / expelling 卡在原地，群里那条带按钮
 * 的验证消息也没人清理。
 *
 * 忽略旧代际不会放行迟到消息：两个入口都已在最前面用相等判定挡掉了非当前代际的
 * 事件，能走到这里的一定属于当前代际。
 */
function currentGenerationRevision(
  entry: Readonly<{ generation: number; revision: number }> | undefined
): number {
  if (entry?.generation !== antiRaidRuntimeState.generation) return 0;
  return entry.revision;
}

/**
 * active、deferred 与 pending delete 按协议互斥；pending deferral 始终仍在 active
 * 内，因此不重复计数。这个 O(1) 计数位于验证事件热边界，不能为每次 upsert
 * 临时构造 Set。
 */
function verificationRecordCount(): number {
  return activeVerificationSnapshots.size +
    deferredVerificationRecords.size +
    pendingVerificationDeletes.size;
}

function rejectNewVerificationAtCapacity(key: string): boolean {
  const known: boolean = activeVerificationSnapshots.has(key) ||
    deferredVerificationRecords.has(key) ||
    pendingVerificationDeferrals.has(key) ||
    pendingVerificationDeletes.has(key);
  if (known || verificationRecordCount() < VERIFICATION_RECORD_CAPACITY) {
    return false;
  }
  if (!verificationCapacityFatalState.current) {
    verificationCapacityFatalState.current = true;
    signalBusinessWorkerFatal(new Error(
      `Anti-Raid verification record capacity (${VERIFICATION_RECORD_CAPACITY}) exceeded; ` +
      "refusing new verification state and requiring a supervised restart."
    ));
  }
  return true;
}

/** 接收 Worker 的待验证快照，拒绝旧代际/旧 revision 后更新主线程镜像。 */
export function acceptVerificationUpsert(
  event: VerificationUpsertEvent
): boolean {
  const snapshot: VerificationSnapshot = event.record;
  if (snapshot.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(snapshot.chatId, snapshot.userId);
  if (rejectNewVerificationAtCapacity(key)) return false;
  if (
    deferredVerificationRecords.has(key) ||
    pendingVerificationDeferrals.has(key)
  ) return false;
  const latestRevision: number = Math.max(
    currentGenerationRevision(activeVerificationSnapshots.get(key)),
    currentGenerationRevision(pendingVerificationDeletes.get(key))
  );
  if (snapshot.revision <= latestRevision) return false;
  const critical: boolean = !activeVerificationSnapshots.has(key) ||
    snapshot.phase === "kickPending" ||
    snapshot.phase === "checkingInviter" ||
    snapshot.phase === "expelling";
  activeVerificationSnapshots.set(key, {
    ...snapshot,
    trackedMessageTimes: [...snapshot.trackedMessageTimes],
  });
  pendingVerificationDeletes.delete(key);
  postDiskIO({
    type: "verificationUpsert",
    record: snapshot,
    critical,
  });
  return true;
}

/** 接收 Worker 的 tombstone，保持 active 与待确认删除镜像互斥。 */
export function acceptVerificationDelete(
  event: VerificationDeleteEvent
): boolean {
  if (event.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(event.chatId, event.userId);
  const current: VerificationSnapshot | undefined =
    activeVerificationSnapshots.get(key);
  const deferred: DeferredVerificationRecord | undefined =
    deferredVerificationRecords.get(key) ?? pendingVerificationDeferrals.get(key);
  const pendingRevision: number = currentGenerationRevision(pendingVerificationDeletes.get(key));
  // 水位线同样只认同代际条目，理由见 currentGenerationRevision；`!current` 那半
  // 边判的是「本来就没有活跃记录、也没有待确认墓碑」，与代际无关，保持原样。
  if (
    (!current && deferred === undefined && pendingRevision === 0) ||
    event.revision <= Math.max(
      currentGenerationRevision(current),
      currentGenerationRevision(deferred),
      pendingRevision
    )
  ) return false;
  activeVerificationSnapshots.delete(key);
  deferredVerificationRecords.delete(key);
  pendingVerificationDeferrals.delete(key);
  terminalVerificationAttempts.delete(key);
  persistedVerificationRevisions.delete(key);
  const deletion: { chatId: number; userId: number; generation: number; revision: number; } = {
    chatId: event.chatId,
    userId: event.userId,
    generation: event.generation,
    revision: event.revision,
  };
  pendingVerificationDeletes.set(key, deletion);
  postDiskIO({ type: "verificationDelete", ...deletion });
  return true;
}
