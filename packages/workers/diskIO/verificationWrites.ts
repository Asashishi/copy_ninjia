/** Owner: Disk I/O Worker。负责待验证增量缓冲、timer、append 与持久化回执。 */

import { mkdirSync } from "node:fs";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_ROLLOVER_RETRY_MS,
} from "../../consts/diskIO/verification";
import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverRetryTimer,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { getDateKey } from "../../libs/time";
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
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

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
async function rolloverVerificationDay(
  day: string,
  reply: VerificationReplySink,
  dir: string
): Promise<void> {
  const changes: [string, VerificationFileChange][] = [
    ...verificationPendingChanges.entries(),
  ];
  compactVerificationDay(day, dir);
  await removeOldVerificationDays(day, dir);
  acknowledge(changes, reply);
}

/** 装轮换失败后的唯一重试 timer；到点按当时的配置时区的日期重新维护。 */
function scheduleVerificationRolloverRetry(
  reply: VerificationReplySink,
  dir: string
): void {
  armDiskIOFlushTimer(
    verificationRolloverRetryTimer,
    VERIFICATION_ROLLOVER_RETRY_MS,
    (): Promise<void> => maintainVerificationDayForToday(reply, getDateKey(), dir)
  );
}

/**
 * 发布目标配置时区自然日的 active 快照并清理旧日；失败时保留镜像并安装唯一 unref 重试。
 * 正常的每日调用由 Disk I/O Worker 统一维护 cron 负责。
 */
export async function maintainVerificationDayForToday(
  reply: VerificationReplySink,
  day: string = getDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  cancelDiskIOFlushTimer(verificationFlushTimer);
  cancelDiskIOFlushTimer(verificationRolloverRetryTimer);
  try {
    await rolloverVerificationDay(day, reply, dir);
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to roll pending verification day:", error);
    // 整晚没有新验证消息时也要尽快重试旧日清理，而不是拖到下一午夜。
    scheduleVerificationRolloverRetry(reply, dir);
  }
}

/** 按需装普通验证变化的合并 timer；已装时不重复装。 */
function scheduleVerificationFlush(
  reply: VerificationReplySink,
  dir: string
): void {
  armDiskIOFlushTimer(
    verificationFlushTimer,
    FLUSH_INTERVAL_MS,
    (): Promise<boolean> => flushVerificationChanges(reply, dir)
  );
}

export interface HandleVerificationUpsertParams {
  msg: VerificationUpsertDiskMessage;
  reply: VerificationReplySink;
  dir?: string;
  day?: string;
}

/** 新建与终态立即追加；普通字段变化按 key 合并，累计 FLUSH_MAX_ENTRIES 个 key 或等满 FLUSH_INTERVAL_MS 后追加。 */
export async function handleVerificationUpsert({
  msg,
  reply,
  dir = VERIFICATION_MEMORY_DIR,
  day = getDateKey(),
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
  verificationPendingChanges.set(key, {
    chatId: snapshot.chatId,
    userId: snapshot.userId,
    generation: snapshot.generation,
    revision: snapshot.revision,
    value: snapshot,
  });
  if (
    msg.critical ||
    verificationPendingChanges.size >= FLUSH_MAX_ENTRIES
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
  day = getDateKey(),
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
  verificationPendingChanges.set(key, {
    chatId: msg.chatId,
    userId: msg.userId,
    generation: msg.generation,
    revision: msg.revision,
    value: null,
  });
  await flushVerificationChanges(reply, dir, day);
}

/** 批量追加本窗口最终变化；仅在历史越过阈值时原子收敛 active 镜像。 */
export async function flushVerificationChanges(
  reply: VerificationReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getDateKey()
): Promise<boolean> {
  cancelDiskIOFlushTimer(verificationFlushTimer);

  try {
    mkdirSync(dir, { recursive: true });
    if (verificationFileState.current?.day !== day) {
      await rolloverVerificationDay(day, reply, dir);
      cancelDiskIOFlushTimer(verificationRolloverRetryTimer);
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
