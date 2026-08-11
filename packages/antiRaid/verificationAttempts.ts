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
import { VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } from "../consts/antiRaid/verification";
import { postDiskIO } from "../infra/diskIO";
import { verificationKey, verificationKeyPrefix } from "../libs/verificationKey";
import type {
  DeferredVerificationRecord,
  VerificationAttemptPermitRequest,
  VerificationAttemptPermitResult,
  VerificationDeferredEvent,
  VerificationSnapshot,
} from "../types/antiRaid";

function isTerminalSnapshot(
  snapshot: VerificationSnapshot | undefined
): boolean {
  return snapshot?.phase === "kickPending" ||
    snapshot?.phase === "checkingInviter" ||
    snapshot?.phase === "expelling";
}

/** 主线程原子批准一轮终态执行；批准发生即计数，Worker 崩溃也不退还。 */
export function grantVerificationAttempt(
  request: VerificationAttemptPermitRequest
): VerificationAttemptPermitResult {
  const currentAttempt: number = terminalVerificationAttempts.get(request.key) ?? 0;
  if (request.generation !== antiRaidRuntimeState.generation) {
    return { status: "stale", attempt: currentAttempt };
  }
  if (deferredVerificationRecords.has(request.key)) {
    return { status: "exhausted", attempt: currentAttempt };
  }
  if (pendingVerificationDeferrals.has(request.key)) {
    return { status: "exhausted", attempt: currentAttempt };
  }
  const snapshot: VerificationSnapshot | undefined =
    activeVerificationSnapshots.get(request.key);
  if (
    snapshot === undefined ||
    !isTerminalSnapshot(snapshot) ||
    snapshot.generation !== request.generation ||
    snapshot.revision !== request.revision
  ) {
    return { status: "stale", attempt: currentAttempt };
  }
  if (currentAttempt >= VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS) {
    return { status: "exhausted", attempt: currentAttempt };
  }
  const attempt: number = currentAttempt + 1;
  terminalVerificationAttempts.set(request.key, attempt);
  return { status: "granted", attempt };
}

/**
 * 接收 Worker 的预算耗尽事件：只把完整快照移出本进程活动镜像，不写 tombstone。
 */
export function acceptVerificationDeferred(
  event: VerificationDeferredEvent
): boolean {
  const record: DeferredVerificationRecord = event.record;
  if (record.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(record.chatId, record.userId);
  const current: VerificationSnapshot | undefined =
    activeVerificationSnapshots.get(key);
  if (
    current === undefined ||
    !isTerminalSnapshot(current) ||
    current.generation !== record.generation ||
    current.revision !== record.revision
  ) {
    return false;
  }
  terminalVerificationAttempts.set(
    key,
    VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS
  );
  const persisted: { generation: number; revision: number } | undefined =
    persistedVerificationRevisions.get(key);
  if (
    persisted?.generation === record.generation &&
    persisted.revision === record.revision
  ) {
    finalizeVerificationDeferral(key, record);
  } else {
    pendingVerificationDeferrals.set(key, { ...record });
  }
  return true;
}

function finalizeVerificationDeferral(
  key: string,
  record: DeferredVerificationRecord
): void {
  activeVerificationSnapshots.delete(key);
  persistedVerificationRevisions.delete(key);
  pendingVerificationDeletes.delete(key);
  pendingVerificationDeferrals.delete(key);
  deferredVerificationRecords.set(key, { ...record });
}

/** 最新 revision 落盘后才丢弃完整活动镜像，保证 DiskIO 重建仍有完整重放源。 */
export function settlePersistedVerificationDeferral(
  key: string,
  generation: number,
  revision: number
): boolean {
  const pending: DeferredVerificationRecord | undefined =
    pendingVerificationDeferrals.get(key);
  const current: VerificationSnapshot | undefined =
    activeVerificationSnapshots.get(key);
  if (
    pending?.generation !== generation ||
    pending.revision !== revision ||
    current?.generation !== generation ||
    current.revision !== revision
  ) {
    return false;
  }
  finalizeVerificationDeferral(key, pending);
  return true;
}

/** Anti-Raid Worker 重建时把延后闩锁提升到新代际，供新 isolate 精确接管。 */
export function advanceDeferredVerificationGeneration(generation: number): void {
  for (const [key, record] of deferredVerificationRecords) {
    deferredVerificationRecords.set(key, { ...record, generation });
  }
  for (const [key, record] of pendingVerificationDeferrals) {
    pendingVerificationDeferrals.set(key, { ...record, generation });
  }
}

/**
 * 显式关闭守卫或群 teardown 时删除延后记录；这时取消动作是权威意图，必须落
 * tombstone，不能留到下次完整进程启动复活。
 */
export function deleteDeferredVerificationsForChat(chatId: number): number {
  const prefix: string = verificationKeyPrefix(chatId);
  let deleted: number = 0;
  const records: Map<string, DeferredVerificationRecord> = new Map([
    ...deferredVerificationRecords,
    ...pendingVerificationDeferrals,
  ]);
  for (const [key, record] of records) {
    if (!key.startsWith(prefix)) continue;
    const revision: number = record.revision + 1;
    const deletion: DeferredVerificationRecord = {
      chatId: record.chatId,
      userId: record.userId,
      generation: antiRaidRuntimeState.generation,
      revision,
    };
    deferredVerificationRecords.delete(key);
    pendingVerificationDeferrals.delete(key);
    activeVerificationSnapshots.delete(key);
    terminalVerificationAttempts.delete(key);
    persistedVerificationRevisions.delete(key);
    pendingVerificationDeletes.set(key, deletion);
    postDiskIO({ type: "verificationDelete", ...deletion });
    deleted++;
  }
  return deleted;
}

/** 完整进程启动/终止边界清空所有非持久化预算与延后索引。 */
export function resetVerificationAttemptRuntime(): void {
  terminalVerificationAttempts.clear();
  deferredVerificationRecords.clear();
  pendingVerificationDeferrals.clear();
  verificationCapacityFatalState.current = false;
}
