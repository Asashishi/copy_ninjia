import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "../diskIO/transport";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import { blocklistEntryCache } from "../../cache/main/identityStorage";
import {
  temporaryAdBypassActivityCache,
  temporaryAdBypassWriteRevision,
  unacknowledgedTemporaryAdBypassWrites,
} from "../../cache/main/temporaryAdBypass";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { assertTemporaryAdBypassActivity } from "../../database/codec/temporaryAdBypass";
import { assertTelegramIdentityId } from "../../database/codec/identity";
import { logger } from "../logger";
import * as diskIO from "../diskIO";
import {
  advanceTemporaryAdBypassActivity,
  isTemporaryAdBypassActive,
  isTemporaryAdBypassActivityRetained,
} from "../../states/temporaryAdBypass";
import type {
  DiskIORecoveryTransport,
  TemporaryAdBypassWriteDiskMessage,
} from "../../types/diskIO/messages";
import type { IdentityStoragePersistedReply } from "../../types/diskIO/replies";
import type {
  StoredTemporaryAdBypassActivity,
  UnacknowledgedTemporaryAdBypassWrite,
} from "../../types/temporaryAdBypass";
import type { TemporaryAdBypassActivity } from "../../types/states/temporaryAdBypass";

/**
 * 查询墙钟当前时刻仍有效的临时广告免检成员关系。只在缓存确有免检记录时才读墙钟，负缓存与
 * 未获免检的常态查询不取时钟；调用方已捕获时刻时改用 hasActiveTemporaryAdBypassAt。
 */
export function hasActiveTemporaryAdBypass(id: number): boolean {
  const activity: Readonly<TemporaryAdBypassActivity> | null | undefined =
    temporaryAdBypassActivityCache.get(id);
  if (!activity?.adBypass) return false;
  return isTemporaryAdBypassActive(activity, Date.now());
}

/** 使用同一消息已经捕获的墙钟值查询临时广告免检成员关系。 */
export function hasActiveTemporaryAdBypassAt(
  id: number,
  now: number
): boolean {
  const activity: Readonly<TemporaryAdBypassActivity> | null | undefined =
    temporaryAdBypassActivityCache.get(id);
  if (!activity?.adBypass) return false;
  return isTemporaryAdBypassActive(activity, now);
}

/** 批量读取回执叠加主线程未 ACK 最终值后写入正/负 LRU。 */
export function hydrateTemporaryAdBypassActivities(
  rows: readonly StoredTemporaryAdBypassActivity[],
  requested: ReadonlySet<number>,
  ids: readonly number[]
): void {
  const stored: Map<number, Readonly<TemporaryAdBypassActivity>> = new Map();
  for (const row of rows) {
    assertTelegramIdentityId(row.id, "temporary ad bypass read reply");
    if (!requested.has(row.id) || stored.has(row.id)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate temporary ad bypass identity ${row.id}.`
      );
    }
    assertTemporaryAdBypassActivity(
      row,
      `temporary_ad_bypass_entries[${row.id}]`
    );
    stored.set(row.id, {
      adBypass: row.adBypass,
      adBypassGrantedAt: row.adBypassGrantedAt,
      qualifiedDays: row.qualifiedDays,
      sendCount: row.sendCount,
      countedAt: row.countedAt,
      qualifiedAt: row.qualifiedAt,
    });
  }
  for (const id of ids) {
    const pending: UnacknowledgedTemporaryAdBypassWrite | undefined =
      unacknowledgedTemporaryAdBypassWrites.get(id);
    temporaryAdBypassActivityCache.set(
      id,
      pending === undefined ? stored.get(id) ?? null : pending.activity
    );
  }
}

/**
 * 发布一次临时累计最终值（activity 为 null 表示墓碑）。非墓碑只来自
 * recordTemporaryAdBypassActivity，它在主键已预热时才推进累计。
 */
function queueTemporaryAdBypassWrite(
  id: number,
  activity: Readonly<TemporaryAdBypassActivity> | null
): boolean {
  assertTelegramIdentityId(id, "temporary ad bypass write");
  if (activity !== null) {
    assertTemporaryAdBypassActivity(activity, `temporary_ad_bypass_entries[${id}]`);
  }
  if (!Number.isSafeInteger(temporaryAdBypassWriteRevision.current + 1)) {
    throw new Error("Temporary ad bypass revision space is exhausted.");
  }
  const revision: number = temporaryAdBypassWriteRevision.current + 1;
  const message: TemporaryAdBypassWriteDiskMessage = { type: "temporaryAdBypassWrite", id, activity, revision };
  const entries: number = unacknowledgedTemporaryAdBypassWrites.size +
    (unacknowledgedTemporaryAdBypassWrites.has(id) ? 0 : 1);
  assertStorageAdmission(entries, entries * storageWriteCost(null));
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused temporary ad bypass state publication.");
  temporaryAdBypassWriteRevision.current = revision;
  temporaryAdBypassActivityCache.set(id, activity);
  unacknowledgedTemporaryAdBypassWrites.set(id, { activity, revision });
  if (diskIO.postDiskIO(message)) return true;
  logger.error(
    `Failed to queue temporary ad bypass identity ${id}; retaining revision ${revision} for replay.`
  );
  return false;
}

/**
 * 计入一条已通过入口门禁的群发言；该主键未预热时返回 undefined，不创建记录。
 *
 * 临时累计与黑名单互斥（见 docs/cn/04-invariants.md）：黑名单 LRU 命中或冷缺失
 * 时同样返回 undefined，只有确认不在黑名单的身份才推进累计。
 *
 * 状态机原样返回入参时没有新事实要落盘：跳过 revision 递增、LRU 写、未 ACK
 * 记账与投递。这一路不刷新 `LruCache.set` 的热度，调用方须在同一条消息上先经
 * `hasActiveTemporaryAdBypassAt` 读过该主键，由那次 `get` 维持热度。投递失败由
 * queueTemporaryAdBypassWrite 记日志并保留未 ACK 最终值等待重放。
 * @returns 计入后的最终累计；未计入时为 undefined。
 */
export function recordTemporaryAdBypassActivity(
  id: number,
  now: number = Date.now()
): Readonly<TemporaryAdBypassActivity> | undefined {
  if (
    !temporaryAdBypassActivityCache.has(id) ||
    blocklistEntryCache.peek(id) !== null
  ) return undefined;
  const current: Readonly<TemporaryAdBypassActivity> | null =
    temporaryAdBypassActivityCache.peek(id) ?? null;
  const activity: Readonly<TemporaryAdBypassActivity> =
    advanceTemporaryAdBypassActivity(current, now);
  if (activity !== current) queueTemporaryAdBypassWrite(id, activity);
  return activity;
}

/** 删除整条临时累计：广告判定为 true、晋升永久白名单后与 /block 拉黑时调用；不存在时幂等成功。 */
export function clearTemporaryAdBypassActivity(id: number): boolean {
  const cached: boolean = temporaryAdBypassActivityCache.has(id);
  if (cached && temporaryAdBypassActivityCache.peek(id) === null) return true;
  // 删除不依赖旧值：缓存冷缺失时同样发布墓碑，并保留到 ACK。
  return queueTemporaryAdBypassWrite(id, null);
}

/**
 * 同 clearTemporaryAdBypassActivity，但持久化 Worker 拒收时抛出：广告判定 true 与拉黑必须先撤掉
 * 临时累计才能继续处置，拒收即中止本次处置。
 */
export function clearTemporaryAdBypassActivityOrThrow(id: number): void {
  if (clearTemporaryAdBypassActivity(id)) return;
  throw new Error(
    `Temporary ad bypass reset for identity ${id} was rejected by the persistence Worker.`
  );
}

function settleTemporaryAdBypassWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.temporaryAdBypassWrites) {
    if (
      unacknowledgedTemporaryAdBypassWrites.get(persisted.id)?.revision ===
      persisted.revision
    ) {
      unacknowledgedTemporaryAdBypassWrites.delete(persisted.id);
    }
  }
}

function replayTemporaryAdBypassWrites(transport: DiskIORecoveryTransport): boolean {
  const now: number = Date.now();
  const writes: readonly (readonly [number, UnacknowledgedTemporaryAdBypassWrite])[] =
    [...unacknowledgedTemporaryAdBypassWrites.entries()].sort(
      (
        left: readonly [number, UnacknowledgedTemporaryAdBypassWrite],
        right: readonly [number, UnacknowledgedTemporaryAdBypassWrite]
      ): number => left[1].revision - right[1].revision
    );
  for (const [id, change] of writes) {
    const activity: Readonly<TemporaryAdBypassActivity> | null =
      change.activity !== null &&
        isTemporaryAdBypassActivityRetained(change.activity, now)
        ? change.activity
        : null;
    if (activity !== change.activity) {
      const normalized: UnacknowledgedTemporaryAdBypassWrite = {
        activity,
        revision: change.revision,
      };
      unacknowledgedTemporaryAdBypassWrites.set(id, normalized);
      temporaryAdBypassActivityCache.set(id, activity);
    }
    if (!transport.post({
      type: "temporaryAdBypassWrite",
      id,
      activity,
      revision: change.revision,
    } satisfies TemporaryAdBypassWriteDiskMessage)) return false;
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleTemporaryAdBypassWrites);
diskIO.onDiskIORespawn(
  "temporary ad bypass",
  DISK_IO_RESPAWN_PRIORITIES.TEMPORARY_AD_BYPASS,
  replayTemporaryAdBypassWrites
);
