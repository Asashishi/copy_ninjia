/** Owner: Disk I/O Worker。负责待验证增量缓冲、timer、append 与持久化回执。 */

import { mkdirSync } from "node:fs";
import { DAY_MS, PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  TOKYO_OFFSET_MS,
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_FLUSH_INTERVAL_MS,
  VERIFICATION_FLUSH_MAX_KEYS,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { getTokyoDateKey } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationSnapshot } from "../../types/antiRaid";
import type {
  VerificationDeleteDiskMessage,
  VerificationFileChange,
  VerificationPersistedReply,
  VerificationUpsertDiskMessage,
} from "../../types/diskIO";
import { appendToDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { storedVerificationSnapshot } from "./verificationCodec";
import {
  compactVerificationDay,
  removeOldVerificationDays,
} from "./verificationRecovery";

export type VerificationReplySink = (reply: VerificationPersistedReply) => void;

function sameOrNewer(
  change: VerificationFileChange | undefined,
  generation: number,
  revision: number
): boolean {
  return change?.generation === generation && change.revision >= revision;
}

function acknowledge(
  changes: [string, VerificationFileChange][],
  reply: VerificationReplySink
): void {
  for (const [key, change] of changes) {
    if (verificationPendingChanges.get(key) === change) {
      verificationPendingChanges.delete(key);
    }
    reply({
      type: "verificationPersisted",
      key,
      generation: change.generation,
      revision: change.revision,
      deleted: change.value === null,
    });
  }
}

/** 跨日先发布新日 active 快照，成功后才删旧日文件，跨午夜 pending 不逃逸。 */
function rolloverVerificationDay(
  day: string,
  reply: VerificationReplySink,
  dir: string
): void {
  const changes: [string, VerificationFileChange][] = [
    ...verificationPendingChanges.entries(),
  ];
  compactVerificationDay(day, dir);
  removeOldVerificationDays(day, dir);
  acknowledge(changes, reply);
}

function msUntilNextTokyoDay(nowMs: number = Date.now()): number {
  const tokyo: Date = new Date(nowMs + TOKYO_OFFSET_MS);
  const nextUtcMs: number = Date.UTC(
    tokyo.getUTCFullYear(),
    tokyo.getUTCMonth(),
    tokyo.getUTCDate() + 1
  ) - TOKYO_OFFSET_MS;
  return Math.max(1, Math.min(DAY_MS, nextUtcMs - nowMs + 50));
}

function armVerificationRollover(
  reply: VerificationReplySink,
  dir: string,
  delayMs: number
): void {
  verificationRolloverTimer.timer = setTimeout((): void => {
    verificationRolloverTimer.timer = null;
    try {
      rolloverVerificationDay(getTokyoDateKey(), reply, dir);
      scheduleVerificationRollover(reply, dir);
    } catch (error: unknown) {
      console.error("[diskIOWorker] failed to roll pending verification day:", error);
      // 整晚没有新验证消息时也要尽快重试旧日清理，而不是拖到下一午夜。
      armVerificationRollover(reply, dir, 1_000);
    }
  }, delayMs);
  verificationRolloverTimer.timer.unref();
}

/** 单个 unref 定时器负责午夜轮换，不按记录创建维护定时器。 */
export function scheduleVerificationRollover(
  reply: VerificationReplySink,
  dir: string = VERIFICATION_MEMORY_DIR
): void {
  if (verificationRolloverTimer.timer !== null) {
    clearTimeout(verificationRolloverTimer.timer);
  }
  armVerificationRollover(reply, dir, msUntilNextTokyoDay());
}

function scheduleVerificationFlush(
  reply: VerificationReplySink,
  dir: string
): void {
  if (verificationFlushTimer.timer !== null) return;
  verificationFlushTimer.timer = setTimeout((): void => {
    verificationFlushTimer.timer = null;
    flushVerificationChanges(reply, dir);
  }, VERIFICATION_FLUSH_INTERVAL_MS);
  verificationFlushTimer.timer.unref();
}

export interface HandleVerificationUpsertParams {
  msg: VerificationUpsertDiskMessage;
  reply: VerificationReplySink;
  dir?: string;
  day?: string;
}

/** 新建立即追加；普通字段变化按 key 在 250ms 窗口内合并。 */
export function handleVerificationUpsert({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getTokyoDateKey(),
}: HandleVerificationUpsertParams): void {
  const key: string = verificationKey(msg.record.chatId, msg.record.userId);
  const pending: VerificationFileChange | undefined =
    verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.record.generation, msg.record.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (
    current?.generation === msg.record.generation &&
    current.revision >= msg.record.revision
  ) return;

  const snapshot: VerificationSnapshot = {
    ...msg.record,
    trackedMessageTimes: [...msg.record.trackedMessageTimes],
  };
  verificationWorkerCache.set(key, snapshot);
  verificationPendingChanges.set(key, { ...snapshot, value: snapshot });
  if (
    msg.critical ||
    verificationPendingChanges.size >= VERIFICATION_FLUSH_MAX_KEYS
  ) {
    flushVerificationChanges(reply, dir, day);
  } else {
    scheduleVerificationFlush(reply, dir);
  }
}

export interface HandleVerificationDeleteParams {
  msg: VerificationDeleteDiskMessage;
  reply: VerificationReplySink;
  dir?: string;
  day?: string;
}

/** 终结清掉同 key 缓冲 upsert、立即追加 durable tombstone 并回执。 */
export function handleVerificationDelete({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getTokyoDateKey(),
}: HandleVerificationDeleteParams): void {
  const key: string = verificationKey(msg.chatId, msg.userId);
  const pending: VerificationFileChange | undefined =
    verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.generation, msg.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (
    current?.generation === msg.generation &&
    current.revision >= msg.revision
  ) return;

  verificationWorkerCache.delete(key);
  verificationPendingChanges.set(key, { ...msg, value: null });
  flushVerificationChanges(reply, dir, day);
}

/** 批量追加本窗口最终变化；仅在历史越过阈值时原子收敛 active 镜像。 */
export function flushVerificationChanges(
  reply: VerificationReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getTokyoDateKey()
): boolean {
  if (verificationFlushTimer.timer !== null) {
    clearTimeout(verificationFlushTimer.timer);
    verificationFlushTimer.timer = null;
  }

  try {
    mkdirSync(dir, { recursive: true });
    if (verificationFileState.current?.day !== day) {
      rolloverVerificationDay(day, reply, dir);
      return true;
    }
    if (verificationPendingChanges.size === 0) return true;

    const changes: [string, VerificationFileChange][] = [
      ...verificationPendingChanges.entries(),
    ];
    const chunks: string[] = [];
    for (const [key, change] of changes) {
      chunks.push(serializeDayFileEntry(
        key,
        change.value === null
          ? null
          : storedVerificationSnapshot(change.value)
      ));
    }
    const chunk: string = chunks.join(",\n");
    const appendedBytes: number = Buffer.byteLength(chunk) +
      (verificationFileState.current.empty ? 4 : 2);
    if (
      verificationFileState.appendedEntries + changes.length >=
        VERIFICATION_FILE_COMPACT_ENTRIES ||
      verificationFileState.appendedBytes + appendedBytes >=
        VERIFICATION_FILE_COMPACT_BYTES
    ) {
      compactVerificationDay(day, dir);
      acknowledge(changes, reply);
      return true;
    }

    appendToDayFile({
      dir,
      state: verificationFileState.current,
      chunk,
      mode: PERSISTED_FILE_MODE,
    });
    verificationFileState.appendedEntries += changes.length;
    verificationFileState.appendedBytes += appendedBytes;
    acknowledge(changes, reply);
    return true;
  } catch (error: unknown) {
    verificationFileState.current = null;
    console.error("[diskIOWorker] failed to append pending verification JSON:", error);
    scheduleVerificationFlush(reply, dir);
    return false;
  }
}
