/**
 * 黑名单成员移除 outbox 的唯一落盘 owner。文件是当前 version=1 的全量快照，
 * 每次变化都用 tmp + fsync + rename 原子替换；损坏时拒绝启动，不能把安全任务
 * 静默降级为空。主线程只在 update 被确认前要求一次统一 flush。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  blocklistRemovalOutbox,
  blocklistRemovalOutboxDirty,
  resetBlocklistRemovalOutboxCache,
} from "../../cache/diskIO/blocklistRemovals";
import {
  BLOCKLIST_REMOVAL_ENTRY_KEYS,
  BLOCKLIST_REMOVAL_FILE_KEYS,
  BLOCKLIST_REMOVAL_FAILURE_TYPES,
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
  BLOCKLIST_REMOVAL_OUTBOX_VERSION,
  BLOCKLIST_REMOVAL_PARAM_KEYS,
} from "../../consts/antiRaid/blocklist";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  BLOCKLIST_MEMORY_DIR,
  BLOCKLIST_REMOVAL_OUTBOX_PATH,
  TMP_FILE_SUFFIX,
} from "../../consts/paths";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import type {
  BlocklistRemovalFailure,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";
import type { BlocklistRemovalsDiskMessage } from "../../types/diskIO";
import type { BlocklistRemovalOutboxFile } from "../../types/diskIO/storage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every(
    (key: string): boolean => allowed.includes(key)
  );
}

function isFailureType(value: unknown): value is BlocklistRemovalFailure {
  return typeof value === "string" &&
    BLOCKLIST_REMOVAL_FAILURE_TYPES.includes(value as BlocklistRemovalFailure);
}

function decodeParams(value: unknown, index: number): RemoveBlockedMembersParams {
  if (!isRecord(value) || !hasOnlyKeys(value, BLOCKLIST_REMOVAL_PARAM_KEYS)) {
    throw new Error(`Blocklist removal outbox entry ${index} has invalid params.`);
  }
  if (!Number.isSafeInteger(value.chatId) || value.chatId === 0) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid chatId.`);
  }
  if (!Number.isSafeInteger(value.removalId) || (value.removalId as number) < 1) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid removalId.`);
  }
  if (typeof value.probeMembership !== "boolean") {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid probeMembership.`);
  }
  if (
    !Array.isArray(value.userIds) ||
    value.userIds.length === 0 ||
    value.userIds.some((userId: unknown): boolean => !Number.isSafeInteger(userId) || userId === 0)
  ) {
    throw new Error(`Blocklist removal outbox entry ${index} has invalid userIds.`);
  }
  const userIds: number[] = value.userIds as number[];
  if (new Set(userIds).size !== userIds.length) {
    throw new Error(`Blocklist removal outbox entry ${index} contains duplicate userIds.`);
  }
  if (
    value.joinedAt !== undefined &&
    (typeof value.joinedAt !== "number" || !Number.isSafeInteger(value.joinedAt) || value.joinedAt < 0)
  ) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid joinedAt.`);
  }
  if (
    value.announcementMessageId !== undefined &&
    (!Number.isSafeInteger(value.announcementMessageId) || (value.announcementMessageId as number) < 1)
  ) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid announcementMessageId.`);
  }
  return {
    chatId: value.chatId as number,
    userIds: [...userIds],
    probeMembership: value.probeMembership,
    removalId: value.removalId as number,
    joinedAt: value.joinedAt,
    announcementMessageId: value.announcementMessageId as number | undefined,
  };
}

function decodeEntry(value: unknown, index: number): PendingBlockedRemoval {
  if (!isRecord(value) || !hasOnlyKeys(value, BLOCKLIST_REMOVAL_ENTRY_KEYS)) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid shape.`);
  }
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
    throw new Error(`Blocklist removal outbox entry ${index} has invalid attempts.`);
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid createdAt.`);
  }
  if (
    value.lastFailure !== null &&
    !isFailureType(value.lastFailure)
  ) {
    throw new Error(`Blocklist removal outbox entry ${index} has an invalid lastFailure.`);
  }
  return {
    params: decodeParams(value.params, index),
    createdAt: value.createdAt,
    attempts: value.attempts as number,
    lastFailure: value.lastFailure,
  };
}

function decodeOutbox(parsed: unknown): Map<number, PendingBlockedRemoval> {
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, BLOCKLIST_REMOVAL_FILE_KEYS) ||
    parsed.version !== BLOCKLIST_REMOVAL_OUTBOX_VERSION
  ) {
    throw new Error(
      `Blocklist removal outbox must use the current version=${BLOCKLIST_REMOVAL_OUTBOX_VERSION} schema.`
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error("Blocklist removal outbox entries must be an array.");
  }
  if (parsed.entries.length > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox exceeds ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} entries.`
    );
  }
  const decoded: Map<number, PendingBlockedRemoval> = new Map();
  for (let index: number = 0; index < parsed.entries.length; index++) {
    const entry: PendingBlockedRemoval = decodeEntry(parsed.entries[index], index);
    const removalId: number = entry.params.removalId;
    if (decoded.has(removalId)) {
      throw new Error(`Blocklist removal outbox contains duplicate removalId ${removalId}.`);
    }
    decoded.set(removalId, entry);
  }
  return decoded;
}

function clonePending(pending: PendingBlockedRemoval): PendingBlockedRemoval {
  return {
    params: { ...pending.params, userIds: [...pending.params.userIds] },
    createdAt: pending.createdAt,
    attempts: pending.attempts,
    lastFailure: pending.lastFailure,
  };
}

function sweepOrphanedTemps(): void {
  const prefix: string = `.${basename(BLOCKLIST_REMOVAL_OUTBOX_PATH)}.`;
  for (const name of readdirSync(BLOCKLIST_MEMORY_DIR)) {
    if (!name.startsWith(prefix) || !name.endsWith(TMP_FILE_SUFFIX)) continue;
    try {
      unlinkSync(join(BLOCKLIST_MEMORY_DIR, name));
    } catch (error: unknown) {
      console.error(`[diskIOWorker] failed to remove orphaned blocklist removal temp ${name}:`, error);
    }
  }
}

function writeCurrentOutbox(): boolean {
  const entries: PendingBlockedRemoval[] = [...blocklistRemovalOutbox.values()]
    .sort(
      (left: PendingBlockedRemoval, right: PendingBlockedRemoval): number =>
        left.params.removalId - right.params.removalId
    )
    .map(clonePending);
  const file: BlocklistRemovalOutboxFile = {
    version: BLOCKLIST_REMOVAL_OUTBOX_VERSION,
    entries,
  };
  try {
    atomicWriteTextSync(
      BLOCKLIST_REMOVAL_OUTBOX_PATH,
      JSON.stringify(file, null, 2),
      PERSISTED_FILE_MODE
    );
    blocklistRemovalOutboxDirty.current = false;
    return true;
  } catch (error: unknown) {
    blocklistRemovalOutboxDirty.current = true;
    console.error("[diskIOWorker] failed to persist the blocklist removal outbox:", error);
    return false;
  }
}

/** 启动恢复；文件不存在表示当前没有尚未完成的任务。 */
export function hydrateBlocklistRemovalOutbox(): Map<number, PendingBlockedRemoval> {
  resetBlocklistRemovalOutboxCache();
  mkdirSync(BLOCKLIST_MEMORY_DIR, { recursive: true });
  sweepOrphanedTemps();
  if (!existsSync(BLOCKLIST_REMOVAL_OUTBOX_PATH)) return new Map();
  const decoded: Map<number, PendingBlockedRemoval> = decodeOutbox(
    JSON.parse(readFileSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, "utf8"))
  );
  for (const [removalId, pending] of decoded) {
    blocklistRemovalOutbox.set(removalId, clonePending(pending));
  }
  return new Map(
    [...decoded].map(
      ([removalId, pending]: [number, PendingBlockedRemoval]): [number, PendingBlockedRemoval] =>
        [removalId, clonePending(pending)]
    )
  );
}

/** 主线程镜像变化：替换完整快照并立即原子落盘。 */
export function handleBlocklistRemovalsMessage(msg: BlocklistRemovalsDiskMessage): void {
  if (msg.removals.length > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox exceeds ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} entries.`
    );
  }
  const decodedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let index: number = 0;
  for (const [removalId, pending] of msg.removals) {
    const decoded: PendingBlockedRemoval = decodeEntry(pending, index);
    if (removalId !== decoded.params.removalId || decodedRemovals.has(removalId)) {
      throw new Error(`Invalid blocklist removal snapshot entry ${removalId}.`);
    }
    decodedRemovals.set(removalId, clonePending(decoded));
    index += 1;
  }
  blocklistRemovalOutbox.clear();
  for (const [removalId, pending] of decodedRemovals) {
    blocklistRemovalOutbox.set(removalId, pending);
  }
  writeCurrentOutbox();
}

/** 统一 flush 的 blocklist 领域分支；失败后按内存中的完整快照重试。 */
export function flushBlocklistRemovalOutbox(): boolean {
  return blocklistRemovalOutboxDirty.current ? writeCurrentOutbox() : true;
}
