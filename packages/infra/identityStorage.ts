/**
 * 主线程身份策略门面：两份 8196 项 LRU、批量冷读、write-through 与事务 ACK 重放。
 * 普通同步权限判断只读这里的热缓存；跨线程请求统一发生在 update 前置预热或明确
 * 的命令/补扫边界，不在每个判定点做 request/reply。
 */

import {
  blocklistEntryCache,
  identityEntryCounts,
  identityWriteRevision,
  unacknowledgedBlocklistWrites,
  unacknowledgedIdentityWrites,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} from "../cache/main/identityStorage";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../consts/identityStorage";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../database/codec/identity";
import * as diskIO from "./diskIO";
import { logger } from "./logger";
import type { CachedUser } from "../types/chatState";
import type {
  DomainFlushOutcome,
  IdentityPolicyWriteDiskMessage,
  IdentityStoragePersistedReply,
} from "../types/diskIO";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../types/identityPolicy";
import type { DiskIORecoveryTransport } from "../types/diskIO";
import type {
  IdentityPolicyRawReadResult,
  UnacknowledgedIdentityWrite,
} from "../types/identityStorage";

interface IdentityDiskIOApi {
  readonly isDiskIOInitialized?: typeof diskIO.isDiskIOInitialized;
  readonly flushDiskIODomainOutcome?: typeof diskIO.flushDiskIODomainOutcome;
  readonly onDiskIORespawn?: typeof diskIO.onDiskIORespawn;
  readonly onIdentityStoragePersisted?: typeof diskIO.onIdentityStoragePersisted;
  readonly postDiskIO?: typeof diskIO.postDiskIO;
  readonly readBlocklistIds?: typeof diskIO.readBlocklistIds;
  readonly readIdentityPolicies?: typeof diskIO.readIdentityPolicies;
}

interface QueuedIdentityWrite {
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly change: UnacknowledgedIdentityWrite;
}

// 叶子单测允许只替换其实际观察的旧 DiskIO 出口；生产装配仍要求完整接口。
const identityDiskIOApi: IdentityDiskIOApi = diskIO;

/** CachedUser 的 Telegram 字段稳定映射到 SQLite meta。 */
export function identityMetadataFromCachedUser(
  user: CachedUser
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: user.isChannel === true
      ? user.title ?? user.first_name ?? ""
      : user.first_name ?? "",
    lastName: user.last_name ?? "",
    username: user.username ?? "",
  };
}

/** 启动恢复只灌入严格计数，不把 SQLite 整表复制到主线程。 */
export function hydrateIdentityStorageCounts(
  whitelistCount: number,
  blocklistCount: number
): void {
  if (!Number.isSafeInteger(whitelistCount) || whitelistCount < 0) {
    throw new Error("Whitelist entry count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(blocklistCount) || blocklistCount < 0) {
    throw new Error("Blocklist entry count must be a non-negative safe integer.");
  }
  whitelistEntryCache.clear();
  blocklistEntryCache.clear();
  identityEntryCounts.whitelist = whitelistCount;
  identityEntryCounts.blocklist = blocklistCount;
}

/** 两份 LRU 是否都已有该主键的正/负结论；热 update 据此避免临时数组。 */
export function isIdentityPolicyCached(id: number): boolean {
  return whitelistEntryCache.has(id) && blocklistEntryCache.has(id);
}

/** 同步读取已预热的白名单；冷缺失按 fail-closed 解释为不存在。 */
export function cachedWhitelistEntry(
  id: number
): Readonly<WhitelistEntryData> | undefined {
  return whitelistEntryCache.get(id) ?? undefined;
}

/** 同步读取已预热的黑名单；冷缺失按 fail-closed 解释为不存在。 */
export function cachedBlocklistEntry(
  id: number
): Readonly<BlocklistEntryData> | undefined {
  return blocklistEntryCache.get(id) ?? undefined;
}

function rawRows(
  rows: readonly (readonly [number, string])[],
  requested: ReadonlySet<number>,
  table: IdentityPolicyTable
): Map<number, string> {
  const result: Map<number, string> = new Map();
  for (const [id, data] of rows) {
    assertTelegramIdentityId(id, `identity ${table} read reply`);
    if (!requested.has(id) || result.has(id)) {
      throw new Error(`Disk I/O returned an unexpected or duplicate ${table} identity ${id}.`);
    }
    result.set(id, data);
  }
  return result;
}

function currentPolicyText(
  table: IdentityPolicyTable,
  id: number,
  databaseText: string | undefined
): string | null {
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  return pending === undefined ? databaseText ?? null : pending.data;
}

async function prefetchChunk(ids: readonly number[]): Promise<void> {
  const read: typeof diskIO.readIdentityPolicies | undefined =
    identityDiskIOApi.readIdentityPolicies;
  if (read === undefined) return;
  const reply: IdentityPolicyRawReadResult = await read(ids);
  const requested: Set<number> = new Set(ids);
  const whitelistRows: Map<number, string> = rawRows(reply.whitelist, requested, "whitelist");
  const blocklistRows: Map<number, string> = rawRows(reply.blocklist, requested, "blocklist");
  for (const id of ids) {
    const whitelistText: string | null = currentPolicyText(
      "whitelist",
      id,
      whitelistRows.get(id)
    );
    const blocklistText: string | null = currentPolicyText(
      "blocklist",
      id,
      blocklistRows.get(id)
    );
    if (whitelistText !== null && blocklistText !== null) {
      throw new Error(`Identity ${id} exists in both whitelist and blocklist views.`);
    }
    whitelistEntryCache.set(
      id,
      whitelistText === null
        ? null
        : decodeWhitelistEntryData(whitelistText, `whitelist_entries[${id}].data`)
    );
    blocklistEntryCache.set(
      id,
      blocklistText === null
        ? null
        : decodeBlocklistEntryData(blocklistText, `blocklist_entries[${id}].data`)
    );
  }
}

/**
 * 批量预热两个 LRU 的冷缺失；本地未 ACK 最终值覆盖数据库迟到结果。
 * 未初始化 Disk I/O 时只可能是独立单测，保持同步读取的 fail-closed 语义。
 *
 * 冷读失败**必须**就地降级，不得让异常逸出：预热挂在 update 前置中间件上
 * （app/registerHandlers.ts），而 Disk I/O 崩溃自愈与诊断回收都会把
 * `diskIORuntime.writable` 置 false，那段窗口里 readIdentityPolicies 直接 reject
 * （infra/diskIO.ts）。异常经 bot.catch 原样重抛后，acknowledged runner 以非零码
 * 退出且不确认 offset，Telegram 重投同一条 update 再次撞进同一个窗口——一次
 * Worker 崩溃自愈就被放大成整进程重启循环（同 isDiskIOBuffering 的头注）。
 * 降级后这批身份仍是冷的，由各判定点按既有 fail-closed 语义决策。
 * @returns 本次没有发生冷读失败为 true；false 表示请求的身份仍缺正/负结论，
 * `/batch_kick` 这类破坏性批量路径必须据此放弃执行而不是按「不在白名单」处置。
 */
export async function prefetchIdentityPolicies(
  candidateIds: readonly number[]
): Promise<boolean> {
  const missing: number[] = [];
  const seen: Set<number> = new Set();
  for (const id of candidateIds) {
    assertTelegramIdentityId(id, "identity policy prefetch");
    if (seen.has(id)) continue;
    seen.add(id);
    if (!whitelistEntryCache.has(id) || !blocklistEntryCache.has(id)) missing.push(id);
  }
  if (missing.length === 0 || identityDiskIOApi.isDiskIOInitialized?.() !== true) return true;
  for (
    let index: number = 0;
    index < missing.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await prefetchChunk(missing.slice(index, index + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES));
    } catch (error: unknown) {
      logger.error(
        `Failed to prefetch ${missing.length} identity policy row(s); leaving them cold:`,
        error
      );
      return false;
    }
  }
  return true;
}

function cacheForTable(
  table: IdentityPolicyTable
): typeof whitelistEntryCache | typeof blocklistEntryCache {
  return table === "whitelist" ? whitelistEntryCache : blocklistEntryCache;
}

function oppositeCache(
  table: IdentityPolicyTable
): typeof whitelistEntryCache | typeof blocklistEntryCache {
  return table === "whitelist" ? blocklistEntryCache : whitelistEntryCache;
}

/**
 * 先发布 LRU 最终值，再登记未 ACK revision 并投给 Disk I/O；数据库读回不能覆盖它。
 * 调用前必须预热该 ID 的正/负结论，才能准确维护表计数与互斥边界。
 */
export function queueIdentityPolicyWrite(
  table: IdentityPolicyTable,
  id: number,
  value: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null
): boolean {
  assertTelegramIdentityId(id, `identity ${table} write`);
  const cache: typeof whitelistEntryCache | typeof blocklistEntryCache = cacheForTable(table);
  const other: typeof whitelistEntryCache | typeof blocklistEntryCache = oppositeCache(table);
  if (!cache.has(id) || !other.has(id)) {
    throw new Error(`Identity ${id} must be prefetched before a ${table} mutation.`);
  }
  if (value !== null && other.peek(id) !== null) {
    throw new Error(`Identity ${id} cannot exist in both whitelist and blocklist.`);
  }
  // 发号失败必须发生在发布 LRU 之前；否则调用方虽然拿到异常，权限热缓存和计数
  // 已经改变，却没有对应未 ACK 最终值可供冷读覆盖或 Worker 重建重放。
  if (!Number.isSafeInteger(identityWriteRevision.current + 1)) {
    throw new Error("Identity policy revision space is exhausted.");
  }
  const previous: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null | undefined =
    cache.peek(id);
  const data: string | null = value === null
    ? null
    : table === "whitelist"
      ? encodeWhitelistEntryData(value as Readonly<WhitelistEntryData>)
      : encodeBlocklistEntryData(value as Readonly<BlocklistEntryData>);
  if (table === "whitelist") {
    whitelistEntryCache.set(id, value as Readonly<WhitelistEntryData> | null);
  } else {
    blocklistEntryCache.set(id, value as Readonly<BlocklistEntryData> | null);
  }
  if (previous === null && value !== null) identityEntryCounts[table]++;
  if (previous !== null && previous !== undefined && value === null) {
    identityEntryCounts[table]--;
  }
  identityWriteRevision.current++;
  const revision: number = identityWriteRevision.current;
  unacknowledgedIdentityWrites(table).set(id, { data, revision });
  const message: IdentityPolicyWriteDiskMessage = {
    type: "identityPolicyWrite",
    table,
    id,
    data,
    revision,
  };
  if (identityDiskIOApi.postDiskIO?.(message) === true) return true;
  logger.error(`Failed to queue ${table} identity ${id}; retaining revision ${revision} for replay.`);
  return false;
}

/**
 * 等指定身份当前未确认最终值真正通过 SQLite 事务并收到精确 revision ACK。
 *
 * 新变化已经由 queueIdentityPolicyWrite 投递，不重复发送；幂等重试则要把先前
 * 可能被同步拒收、但仍留在主线程缓存里的 revision 补投一次。领域 flush 成功
 * 只说明 Worker 报告事务完成，目标 revision 仍未被 ACK 时照样按失败处理，避免
 * 缓存永久背着一条数据库其实没有追平的“未确认”状态。
 */
export async function confirmIdentityPolicyPersisted(
  table: IdentityPolicyTable,
  id: number,
  retryUnacknowledged: boolean
): Promise<void> {
  assertTelegramIdentityId(id, `identity ${table} persistence confirmation`);
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (pending === undefined) return;
  if (retryUnacknowledged) requeueUnacknowledgedIdentityWrite(table, id);
  const flush: typeof diskIO.flushDiskIODomainOutcome | undefined =
    identityDiskIOApi.flushDiskIODomainOutcome;
  if (flush === undefined) {
    throw new Error(`Persistence flush is unavailable for ${table} identity ${id}.`);
  }
  const outcome: DomainFlushOutcome = await flush(table);
  if (outcome.result !== "flushed") {
    const domainNote: string = outcome.failedDomains === undefined
      ? "no per-domain reply"
      : `failed domains: ${outcome.failedDomains.join(", ")}`;
    throw new Error(
      `Persistence flush ${outcome.result} for ${table} identity ${id} revision ${pending.revision}; ${domainNote}.`
    );
  }
  if (
    unacknowledgedIdentityWrites(table).get(id)?.revision === pending.revision
  ) {
    throw new Error(
      `Persistence Worker did not acknowledge ${table} identity ${id} revision ${pending.revision}.`
    );
  }
}

/** 是否至少存在一个黑名单身份；只读启动计数，不持有整表 ID。 */
export function hasAnyBlockedIdentity(): boolean {
  return identityEntryCounts.blocklist > 0;
}

/** 群级补扫读取完整 ID；普通消息热路径只用 LRU，不得调用。 */
export async function listAllBlockedIdentityIds(): Promise<readonly number[]> {
  const read: typeof diskIO.readBlocklistIds | undefined = identityDiskIOApi.readBlocklistIds;
  if (read === undefined) return [];
  const ids: readonly number[] = await read();
  return ids;
}

/** 重投某主键仍未 ACK 的最终值；不创建新 revision。 */
export function requeueUnacknowledgedIdentityWrite(
  table: IdentityPolicyTable,
  id: number
): boolean {
  const change: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (change === undefined) return false;
  const posted: boolean = identityDiskIOApi.postDiskIO?.({
    type: "identityPolicyWrite",
    table,
    id,
    data: change.data,
    revision: change.revision,
  } satisfies IdentityPolicyWriteDiskMessage) === true;
  if (!posted) {
    logger.error(`Failed to re-queue ${table} identity ${id} revision ${change.revision}.`);
  }
  return true;
}

function settleIdentityStorageWrite(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.writes) {
    const pending: Map<number, UnacknowledgedIdentityWrite> =
      unacknowledgedIdentityWrites(persisted.table);
    if (pending.get(persisted.id)?.revision === persisted.revision) {
      pending.delete(persisted.id);
    }
  }
}

function replayIdentityPolicyWrites(transport: DiskIORecoveryTransport): boolean {
  const tables: readonly (readonly [IdentityPolicyTable, Map<number, UnacknowledgedIdentityWrite>])[] = [
    ["whitelist", unacknowledgedWhitelistWrites],
    ["blocklist", unacknowledgedBlocklistWrites],
  ];
  const queued: QueuedIdentityWrite[] = [];
  for (const [table, writes] of tables) {
    for (const [id, change] of writes) queued.push({ table, id, change });
  }
  queued.sort((left: QueuedIdentityWrite, right: QueuedIdentityWrite): number =>
    left.change.revision - right.change.revision);
  for (const write of queued) {
    if (!transport.post({
      type: "identityPolicyWrite",
      table: write.table,
      id: write.id,
      data: write.change.data,
      revision: write.change.revision,
    } satisfies IdentityPolicyWriteDiskMessage)) return false;
  }
  return true;
}

// 部分叶子单测用只暴露旧协议的 diskIO 替身；生产模块始终同时具备这两个入口。
if (identityDiskIOApi.onIdentityStoragePersisted !== undefined) {
  identityDiskIOApi.onIdentityStoragePersisted(settleIdentityStorageWrite);
}
if (identityDiskIOApi.onDiskIORespawn !== undefined) {
  identityDiskIOApi.onDiskIORespawn(
    "identity policies",
    DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST,
    replayIdentityPolicyWrites
  );
}
