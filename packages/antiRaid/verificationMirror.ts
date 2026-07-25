import {
  activeVerificationSnapshots,
  antiRaidRuntimeState,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} from "../cache/antiRaid";
import { verificationKey } from "../libs/verificationKey";
import { postDiskIO } from "../workers/antiRaid/persistence";
import type {
  VerificationDeleteEvent,
  VerificationSnapshot,
  VerificationUpsertEvent,
} from "../types/antiRaid";

/** 接收 Worker 的待验证快照，拒绝旧代际/旧 revision 后更新主线程镜像。 */
export function acceptVerificationUpsert(
  event: VerificationUpsertEvent
): boolean {
  const snapshot: VerificationSnapshot = event.record;
  if (snapshot.generation !== antiRaidRuntimeState.generation) return false;
  const key: string = verificationKey(snapshot.chatId, snapshot.userId);
  const latestRevision: number = Math.max(
    activeVerificationSnapshots.get(key)?.revision ?? 0,
    pendingVerificationDeletes.get(key)?.revision ?? 0
  );
  if (snapshot.revision <= latestRevision) return false;
  const critical: boolean = !activeVerificationSnapshots.has(key) ||
    snapshot.phase === "checkingInviter" ||
    snapshot.phase === "expelling";
  activeVerificationSnapshots.set(key, {
    ...snapshot,
    messageIds: [...snapshot.messageIds],
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
  const pendingRevision: number =
    pendingVerificationDeletes.get(key)?.revision ?? 0;
  if (
    (!current && pendingRevision === 0) ||
    event.revision <= Math.max(current?.revision ?? 0, pendingRevision)
  ) return false;
  activeVerificationSnapshots.delete(key);
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
