/**
 * Anti-Raid 待验证状态的按日增量 JSON。热路径完全复用 appendOnlyDayFile：
 * 顶层 key 是 `chatId:userId`，upsert 追加完整快照，终结追加 null；JSON.parse
 * 对重复 key 取最后值。普通变化按 key 合并，历史达到阈值时收敛为 active
 * 快照；东京日期切换时先写新日 active 快照，再删除旧日文件。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_FILE_MAX_MESSAGE_IDS,
  VERIFICATION_FLUSH_INTERVAL_MS,
  VERIFICATION_FLUSH_MAX_KEYS,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../consts/antiRaid/lockdown";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../cache/diskIO/verification";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { getTokyoDateKey } from "../../libs/time";
import type {
  VerificationDeleteDiskMessage,
  VerificationFileChange,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../../types";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";

type ReplySink = (reply: VerificationPersistedReply) => void;

const TOKYO_OFFSET_MS: number = 9 * 60 * 60 * 1000;
const DAY_MS: number = 24 * 60 * 60 * 1000;
const DAY_FILE_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}\.json$/;
const TOP_LEVEL_ENTRY_PATTERN: RegExp = new RegExp(
  `^${" ".repeat(DAY_FILE_JSON_INDENT)}"(?:[^"\\\\]|\\\\.)+":`,
  "gm"
);

export function verificationFileKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveId(value: unknown): value is number | undefined {
  return value === undefined || isPositiveId(value);
}

/** 对当天文件中的最新值逐字段校验，不把畸形数据带回业务 Worker。 */
export function decodeVerificationSnapshot(key: string, value: unknown): VerificationSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    typeof value.chatId !== "number" ||
    !Number.isSafeInteger(value.chatId) ||
    value.chatId === 0 ||
    !isPositiveId(value.userId) ||
    !isPositiveId(value.generation) ||
    !isPositiveId(value.revision) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > 512 ||
    typeof value.isBot !== "boolean" ||
    !Array.isArray(value.messageIds) ||
    value.messageIds.length > VERIFICATION_FILE_MAX_MESSAGE_IDS ||
    !value.messageIds.every(isPositiveId) ||
    (value.trackedMessageTimes !== undefined && (
      !Array.isArray(value.trackedMessageTimes) ||
      value.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT ||
      !value.trackedMessageTimes.every(isSafeTimestamp)
    )) ||
    !isOptionalPositiveId(value.invitedBy) ||
    !isOptionalPositiveId(value.reminderMessageId) ||
    !isOptionalPositiveId(value.replyReminderMessageId) ||
    typeof value.replyReminderRequested !== "boolean" ||
    !isOptionalPositiveId(value.welcomeAnchorMessageId) ||
    typeof value.reminderSuperseded !== "boolean" ||
    !isSafeTimestamp(value.joinedAt) ||
    !isSafeTimestamp(value.expiresAt) ||
    value.expiresAt < value.joinedAt ||
    key !== verificationFileKey(value.chatId, value.userId)
  ) return null;

  return {
    chatId: value.chatId,
    userId: value.userId,
    generation: value.generation,
    revision: value.revision,
    label: value.label,
    isBot: value.isBot,
    messageIds: [...value.messageIds],
    trackedMessageTimes: value.trackedMessageTimes === undefined ? undefined : [...value.trackedMessageTimes],
    invitedBy: value.invitedBy,
    reminderMessageId: value.reminderMessageId,
    replyReminderMessageId: value.replyReminderMessageId,
    replyReminderRequested: value.replyReminderRequested,
    welcomeAnchorMessageId: value.welcomeAnchorMessageId,
    reminderSuperseded: value.reminderSuperseded,
    joinedAt: value.joinedAt,
    expiresAt: value.expiresAt,
  };
}

function storedSnapshot(snapshot: VerificationSnapshot): Record<string, unknown> {
  return { version: 1, ...snapshot };
}

/** 只删除本目录中明确匹配日期命名的旧 JSON，不碰临时文件或其它资产。 */
export function removeOldVerificationDays(day: string, dir: string = VERIFICATION_MEMORY_DIR): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !DAY_FILE_PATTERN.test(entry.name) || entry.name === `${day}.json`) continue;
    unlinkSync(join(dir, entry.name));
  }
}

/** 把当前 active 镜像原子写成指定日期的规范对象；维护路径才整份重写。 */
export function compactVerificationDay(day: string, dir: string = VERIFICATION_MEMORY_DIR): void {
  mkdirSync(dir, { recursive: true });
  const compacted: Record<string, unknown> = {};
  for (const [key, snapshot] of verificationWorkerCache) compacted[key] = storedSnapshot(snapshot);
  atomicWriteTextSync(
    join(dir, `${day}.json`),
    JSON.stringify(compacted, null, DAY_FILE_JSON_INDENT),
    PERSISTED_FILE_MODE
  );
  verificationFileState.current = openDayFile(dir, day, PERSISTED_FILE_MODE);
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}

/** 启动只读取东京当天文件；旧日文件随即清理。 */
export function recoverVerificationDay(
  day: string = getTokyoDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Map<string, VerificationSnapshot> {
  mkdirSync(dir, { recursive: true });
  resetVerificationPersistenceCache();
  verificationFileState.current = openDayFile(dir, day, PERSISTED_FILE_MODE);
  removeOldVerificationDays(day, dir);

  const path: string = join(dir, `${day}.json`);
  if (!existsSync(path)) return new Map();
  const content: string = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) continue;
    const snapshot: VerificationSnapshot | null = decodeVerificationSnapshot(key, value);
    if (snapshot === null) {
      console.error(`[diskIOWorker] ignoring invalid pending verification record for key ${key}`);
      continue;
    }
    verificationWorkerCache.set(key, snapshot);
  }

  // 重启后无法区分规范 active 基线与其后的重复 key，保守地把当前文件都计入
  // 历史；达到任一阈值就收敛一次。收敛后 bytes 归零，active 本身再大也不会
  // 让后续每条小增量都反复触发整份重写。
  verificationFileState.appendedEntries = content.match(TOP_LEVEL_ENTRY_PATTERN)?.length ?? 0;
  verificationFileState.appendedBytes = verificationFileState.current.size;
  if (
    verificationFileState.appendedEntries >= VERIFICATION_FILE_COMPACT_ENTRIES ||
    verificationFileState.appendedBytes >= VERIFICATION_FILE_COMPACT_BYTES
  ) {
    compactVerificationDay(day, dir);
  }
  return new Map(verificationWorkerCache);
}

function sameOrNewer(change: VerificationFileChange | undefined, generation: number, revision: number): boolean {
  return change?.generation === generation && change.revision >= revision;
}

function acknowledge(changes: [string, VerificationFileChange][], reply: ReplySink): void {
  for (const [key, change] of changes) {
    if (verificationPendingChanges.get(key) === change) verificationPendingChanges.delete(key);
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
function rolloverVerificationDay(day: string, reply: ReplySink, dir: string): void {
  const changes: [string, VerificationFileChange][] = [...verificationPendingChanges.entries()];
  compactVerificationDay(day, dir);
  removeOldVerificationDays(day, dir);
  acknowledge(changes, reply);
}

function msUntilNextTokyoDay(nowMs: number = Date.now()): number {
  const tokyo: Date = new Date(nowMs + TOKYO_OFFSET_MS);
  const nextUtcMs: number = Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth(), tokyo.getUTCDate() + 1) - TOKYO_OFFSET_MS;
  return Math.max(1, Math.min(DAY_MS, nextUtcMs - nowMs + 50));
}

function armVerificationRollover(reply: ReplySink, dir: string, delayMs: number): void {
  verificationRolloverTimer.timer = setTimeout(() => {
    verificationRolloverTimer.timer = null;
    try {
      rolloverVerificationDay(getTokyoDateKey(), reply, dir);
      scheduleVerificationRollover(reply, dir);
    } catch (error: unknown) {
      console.error("[diskIOWorker] failed to roll pending verification day:", error);
      // 即使整晚没有新验证消息，也要尽快重试旧日清理，而不是拖到下一午夜。
      armVerificationRollover(reply, dir, 1_000);
    }
  }, delayMs);
  verificationRolloverTimer.timer.unref();
}

/** 单个 unref 定时器负责午夜轮换，不按记录创建维护定时器。 */
export function scheduleVerificationRollover(reply: ReplySink, dir: string = VERIFICATION_MEMORY_DIR): void {
  if (verificationRolloverTimer.timer !== null) clearTimeout(verificationRolloverTimer.timer);
  armVerificationRollover(reply, dir, msUntilNextTokyoDay());
}

function scheduleVerificationFlush(reply: ReplySink, dir: string): void {
  if (verificationFlushTimer.timer !== null) return;
  verificationFlushTimer.timer = setTimeout(() => {
    verificationFlushTimer.timer = null;
    flushVerificationChanges(reply, dir);
  }, VERIFICATION_FLUSH_INTERVAL_MS);
  verificationFlushTimer.timer.unref();
}

/** 新建立即追加；普通字段变化按 key 在 250ms 窗口内合并。 */
export function handleVerificationUpsert(
  msg: VerificationUpsertDiskMessage,
  reply: ReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getTokyoDateKey()
): void {
  const key: string = verificationFileKey(msg.record.chatId, msg.record.userId);
  const pending: VerificationFileChange | undefined = verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.record.generation, msg.record.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (current?.generation === msg.record.generation && current.revision >= msg.record.revision) return;

  const snapshot: VerificationSnapshot = {
    ...msg.record,
    messageIds: [...msg.record.messageIds],
    trackedMessageTimes: msg.record.trackedMessageTimes === undefined ? undefined : [...msg.record.trackedMessageTimes],
  };
  verificationWorkerCache.set(key, snapshot);
  verificationPendingChanges.set(key, { ...snapshot, value: snapshot });
  if (msg.critical || verificationPendingChanges.size >= VERIFICATION_FLUSH_MAX_KEYS) {
    flushVerificationChanges(reply, dir, day);
  } else {
    scheduleVerificationFlush(reply, dir);
  }
}

/** 终结清掉同 key 缓冲 upsert、追加 null，并立即回执。 */
export function handleVerificationDelete(
  msg: VerificationDeleteDiskMessage,
  reply: ReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getTokyoDateKey()
): void {
  const key: string = verificationFileKey(msg.chatId, msg.userId);
  const pending: VerificationFileChange | undefined = verificationPendingChanges.get(key);
  if (sameOrNewer(pending, msg.generation, msg.revision)) return;
  const current: VerificationSnapshot | undefined = verificationWorkerCache.get(key);
  if (current?.generation === msg.generation && current.revision >= msg.revision) return;

  verificationWorkerCache.delete(key);
  verificationPendingChanges.set(key, { ...msg, value: null });
  flushVerificationChanges(reply, dir, day);
}

/** 批量追加本窗口最终变化；预计越过历史阈值时直接原子收敛 active 镜像。 */
export function flushVerificationChanges(
  reply: ReplySink,
  dir: string = VERIFICATION_MEMORY_DIR,
  day: string = getTokyoDateKey()
): void {
  if (verificationFlushTimer.timer !== null) {
    clearTimeout(verificationFlushTimer.timer);
    verificationFlushTimer.timer = null;
  }

  try {
    mkdirSync(dir, { recursive: true });
    if (verificationFileState.current?.day !== day) {
      rolloverVerificationDay(day, reply, dir);
      return;
    }
    if (verificationPendingChanges.size === 0) return;

    const changes: [string, VerificationFileChange][] = [...verificationPendingChanges.entries()];
    const chunk: string = changes.map(([key, change]) =>
      serializeDayFileEntry(key, change.value === null ? null : storedSnapshot(change.value))
    ).join(",\n");
    const appendedBytes: number = Buffer.byteLength(chunk) + (verificationFileState.current.empty ? 4 : 2);
    if (
      verificationFileState.appendedEntries + changes.length >= VERIFICATION_FILE_COMPACT_ENTRIES ||
      verificationFileState.appendedBytes + appendedBytes >= VERIFICATION_FILE_COMPACT_BYTES
    ) {
      compactVerificationDay(day, dir);
      acknowledge(changes, reply);
      return;
    }

    appendToDayFile(dir, verificationFileState.current, chunk, PERSISTED_FILE_MODE);
    verificationFileState.appendedEntries += changes.length;
    verificationFileState.appendedBytes += appendedBytes;
    acknowledge(changes, reply);
  } catch (error: unknown) {
    verificationFileState.current = null;
    console.error("[diskIOWorker] failed to append pending verification JSON:", error);
    scheduleVerificationFlush(reply, dir);
  }
}
