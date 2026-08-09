/**
 * 黑名单成员移除 outbox 的唯一落盘 owner。文件是当前 version=2 的全量快照，
 * 落盘用 tmp + fsync + rename 原子替换；损坏时拒绝启动，不能把安全任务静默降级
 * 为空。
 *
 * 主线程投来的快照消息只替换镜像并标脏，**写盘发生在统一 flush**——需要 durable
 * 的调用方投完快照都紧接着 await 一次 flush，而批次销账、失败计数这些高频路径
 * 本来就不等确认。逐条就地写盘的话，一批 N 个群的清扫依次完成就是 N 次整份
 * outbox 重写，每份又按已登记的群数增长（见 handleBlocklistRemovalsMessage）。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  blocklistRemovalOutbox,
  blocklistRemovalOutboxDirty,
  resetBlocklistRemovalOutboxCache,
} from "../../cache/workers/diskIO/blocklistRemovals";
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
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import type {
  BlocklistRemovalFailure,
  PendingBlockedRemoval,
  PendingBlockedRemovalParams,
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

function decodeParams(value: unknown, index: number): PendingBlockedRemovalParams {
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
  const chatId: number = value.chatId as number;
  const removalId: number = value.removalId as number;
  // 补扫不冻结名单，因此这三个字段一个都不该出现：带着它们的多半是没迁移干净
  // 的 v1 条目，静默接受等于把一份过期快照当成任务重放（见 types/blocklist.ts）。
  if (value.probeMembership) {
    for (const key of ["userIds", "joinedAt", "announcementMessageId"]) {
      if (value[key] !== undefined) {
        throw new Error(`Blocklist removal outbox entry ${index} is a sweep but carries ${key}.`);
      }
    }
    return { chatId, probeMembership: true, removalId };
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
    chatId,
    probeMembership: false,
    userIds: [...userIds],
    removalId,
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
    params: pending.params.probeMembership
      ? { ...pending.params }
      : { ...pending.params, userIds: [...pending.params.userIds] },
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
  // 排序后直接交给 stringify：序列化只读不改，再 clonePending 一遍就是按
  // 「群数 × 名单长度」多拷一份，而这条路径每次 flush 都要走。
  const entries: PendingBlockedRemoval[] = [...blocklistRemovalOutbox.values()].sort(
    (left: PendingBlockedRemoval, right: PendingBlockedRemoval): number =>
      left.params.removalId - right.params.removalId
  );
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
  let decoded: Map<number, PendingBlockedRemoval>;
  try {
    decoded = decodeOutbox(readJsonInput(BLOCKLIST_REMOVAL_OUTBOX_PATH));
  } catch {
    return invalidInput(
      BLOCKLIST_REMOVAL_OUTBOX_PATH,
      "$",
      `the current version=${BLOCKLIST_REMOVAL_OUTBOX_VERSION} blocklist removal outbox schema`
    );
  }
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

/**
 * 主线程镜像变化：替换完整快照并标脏，**不在这里落盘**。
 *
 * 快照消息本身不是持久化边界——凡是需要 durable 的调用方（`/unblock`、Anti-Raid
 * 投递前的 write-ahead）投完快照都紧接着 await 一次统一 flush，那次 flush 会把
 * 这里标下的脏写出去；不需要 durable 的（批次完成销账、失败计数、启动对账）本来
 * 就不等确认。就地写盘只是让这些高频路径每次变化各付一次
 * tmp + fsync + rename：一批 N 个群的清扫依次完成，就是 N 次整份 outbox 重写，
 * 而每份 outbox 又按已登记的群数增长——O(N²) 的写盘量，正是 docs/cn/04-invariants.md
 * 点名要避开的形态。改为标脏之后，两次 flush 之间的多次变化合成一次写。
 */
export function handleBlocklistRemovalsMessage(msg: BlocklistRemovalsDiskMessage): void {
  if (msg.removals.length > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox exceeds ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} entries.`
    );
  }
  const decodedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let index: number = 0;
  for (const [removalId, pending] of msg.removals) {
    // decodeEntry 已经逐字段重建出全新对象（含 userIds 的副本），跨线程传过来的
    // 结构又是 structured clone 的产物，再 clonePending 一遍是第三份同样内容的
    // 拷贝——快照按「群数 × 名单长度」增长，这一份不是常数开销。
    const decoded: PendingBlockedRemoval = decodeEntry(pending, index);
    if (removalId !== decoded.params.removalId || decodedRemovals.has(removalId)) {
      throw new Error(`Invalid blocklist removal snapshot entry ${removalId}.`);
    }
    decodedRemovals.set(removalId, decoded);
    index += 1;
  }
  blocklistRemovalOutbox.clear();
  for (const [removalId, pending] of decodedRemovals) {
    blocklistRemovalOutbox.set(removalId, pending);
  }
  blocklistRemovalOutboxDirty.current = true;
}

/** 统一 flush 的 blocklist 领域分支；失败后按内存中的完整快照重试。 */
export function flushBlocklistRemovalOutbox(): boolean {
  return blocklistRemovalOutboxDirty.current ? writeCurrentOutbox() : true;
}
