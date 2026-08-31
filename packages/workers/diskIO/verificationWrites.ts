/** Owner: Disk I/O Worker。负责待验证增量缓冲、timer、append 与持久化回执。 */

import { mkdirSync } from "node:fs";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_FLUSH_INTERVAL_MS,
  VERIFICATION_FLUSH_MAX_KEYS,
  VERIFICATION_ROLLOVER_RETRY_MS,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverRetryTimer,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { getTokyoDateKey } from "../../libs/time";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import type {
  VerificationDeleteDiskMessage,
  VerificationFileChange,
  VerificationUpsertDiskMessage,
} from "../../types/diskIO/messages";
import type { VerificationPersistedReply } from "../../types/diskIO/replies";
import { appendToDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";
import { storedVerificationSnapshot } from "./verificationCodec";
import {
  compactVerificationDay,
  removeOldVerificationDays,
} from "./verificationRecovery";
import { enqueueDiskIOOperation } from "./operationQueue";

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

function scheduleVerificationRolloverRetry(
  reply: VerificationReplySink,
  dir: string
): void {
  verificationRolloverRetryTimer.timer = setTimeout((): void => {
    verificationRolloverRetryTimer.timer = null;
    void enqueueDiskIOOperation((): void => {
      maintainVerificationDayForToday(reply, getTokyoDateKey(), dir);
    });
  }, VERIFICATION_ROLLOVER_RETRY_MS);
  verificationRolloverRetryTimer.timer.unref();
}

/**
 * 发布目标东京日 active 快照并清理旧日；失败时保留镜像并安装唯一 unref 重试。
 * 正常的每日调用由 Disk I/O Worker 统一维护 cron 负责。
 */
export function maintainVerificationDayForToday(
  reply: VerificationReplySink,
  day: string = getTokyoDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): void {
  if (verificationFlushTimer.timer !== null) {
    clearTimeout(verificationFlushTimer.timer);
    verificationFlushTimer.timer = null;
  }
  if (verificationRolloverRetryTimer.timer !== null) {
    clearTimeout(verificationRolloverRetryTimer.timer);
    verificationRolloverRetryTimer.timer = null;
  }
  try {
    rolloverVerificationDay(day, reply, dir);
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to roll pending verification day:", error);
    // 整晚没有新验证消息时也要尽快重试旧日清理，而不是拖到下一午夜。
    scheduleVerificationRolloverRetry(reply, dir);
  }
}

function scheduleVerificationFlush(
  reply: VerificationReplySink,
  dir: string
): void {
  if (verificationFlushTimer.timer !== null) return;
  verificationFlushTimer.timer = setTimeout((): void => {
    verificationFlushTimer.timer = null;
    void enqueueDiskIOOperation(async (): Promise<void> => {
      await flushVerificationChanges(reply, dir);
    });
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
export async function handleVerificationUpsert({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getTokyoDateKey(),
}: HandleVerificationUpsertParams): Promise<void> {
  const key: string = verificationKey(msg.record.chatId, msg.record.userId);
  const pending: VerificationFileChange | undefined =
    verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.record.generation, msg.record.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (
    current?.generation === msg.record.generation &&
    current.revision >= msg.record.revision
  ) return;
  if (
    current === undefined &&
    verificationWorkerCache.size >= VERIFICATION_RECORD_CAPACITY
  ) {
    throw new RangeError(
      `Verification persistence capacity (${VERIFICATION_RECORD_CAPACITY}) exceeded.`
    );
  }

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
    await flushVerificationChanges(reply, dir, day);
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
export async function handleVerificationDelete({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getTokyoDateKey(),
}: HandleVerificationDeleteParams): Promise<void> {
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
  await flushVerificationChanges(reply, dir, day);
}

/** 批量追加本窗口最终变化；仅在历史越过阈值时原子收敛 active 镜像。 */
export async function flushVerificationChanges(
  reply: VerificationReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getTokyoDateKey()
): Promise<boolean> {
  if (verificationFlushTimer.timer !== null) {
    clearTimeout(verificationFlushTimer.timer);
    verificationFlushTimer.timer = null;
  }

  try {
    mkdirSync(dir, { recursive: true });
    if (verificationFileState.current?.day !== day) {
      rolloverVerificationDay(day, reply, dir);
      if (verificationRolloverRetryTimer.timer !== null) {
        clearTimeout(verificationRolloverRetryTimer.timer);
        verificationRolloverRetryTimer.timer = null;
      }
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

    await appendToDayFile({
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
