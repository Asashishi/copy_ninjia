import {
  temporaryWhitelistActivityCache,
  temporaryWhitelistWriteRevision,
  unacknowledgedTemporaryWhitelistWrites,
} from "../../cache/main/temporaryWhitelist";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { assertTemporaryWhitelistActivity } from "../../database/codec/temporaryWhitelist";
import { assertTelegramIdentityId } from "../../database/codec/identity";
import { logger } from "../logger";
import * as diskIO from "../diskIO";
import {
  advanceTemporaryWhitelistActivity,
  isTemporaryWhitelistActive,
  isTemporaryWhitelistActivityRetained,
} from "../../states/temporaryWhitelist";
import type {
  DiskIORecoveryTransport,
  TemporaryWhitelistWriteDiskMessage,
} from "../../types/diskIO/messages";
import type { IdentityStoragePersistedReply } from "../../types/diskIO/replies";
import type {
  StoredTemporaryWhitelistActivity,
  RecordedTemporaryWhitelistActivity,
  TemporaryWhitelistActivity,
  UnacknowledgedTemporaryWhitelistWrite,
} from "../../types/temporaryWhitelist";

/** 临时白名单 LRU 是否已有该主键的正/负结论。 */
export function isTemporaryWhitelistActivityCached(id: number): boolean {
  return temporaryWhitelistActivityCache.has(id);
}

/** 查询墙钟当前东京日仍有效的临时白名单成员关系。 */
export function hasActiveTemporaryWhitelist(id: number): boolean {
  const activity: Readonly<TemporaryWhitelistActivity> | null | undefined =
    temporaryWhitelistActivityCache.get(id);
  if (!activity?.tempWhite) return false;
  return isTemporaryWhitelistActive(activity);
}

/** 使用同一消息已经捕获的墙钟值查询临时白名单成员关系。 */
export function hasActiveTemporaryWhitelistAt(
  id: number,
  now: number
): boolean {
  const activity: Readonly<TemporaryWhitelistActivity> | null | undefined =
    temporaryWhitelistActivityCache.get(id);
  if (!activity?.tempWhite) return false;
  return isTemporaryWhitelistActive(activity, now);
}

/** 批量读取回执叠加主线程未 ACK 最终值后写入 8192 项正/负 LRU。 */
export function hydrateTemporaryWhitelistActivities(
  rows: readonly StoredTemporaryWhitelistActivity[],
  requested: ReadonlySet<number>,
  ids: readonly number[]
): void {
  const stored: Map<number, Readonly<TemporaryWhitelistActivity>> = new Map();
  for (const row of rows) {
    assertTelegramIdentityId(row.id, "temporary whitelist read reply");
    if (!requested.has(row.id) || stored.has(row.id)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate temporary whitelist identity ${row.id}.`
      );
    }
    assertTemporaryWhitelistActivity(
      row,
      `temporary_whitelist_entries[${row.id}]`
    );
    stored.set(row.id, {
      tempWhite: row.tempWhite,
      tempWhiteAt: row.tempWhiteAt,
      tempWhiteCount: row.tempWhiteCount,
      sendCount: row.sendCount,
      countedAt: row.countedAt,
      qualifiedAt: row.qualifiedAt,
    });
  }
  for (const id of ids) {
    const pending: UnacknowledgedTemporaryWhitelistWrite | undefined =
      unacknowledgedTemporaryWhitelistWrites.get(id);
    temporaryWhitelistActivityCache.set(
      id,
      pending === undefined ? stored.get(id) ?? null : pending.activity
    );
  }
}

function queueTemporaryWhitelistWrite(
  id: number,
  activity: Readonly<TemporaryWhitelistActivity> | null
): boolean {
  assertTelegramIdentityId(id, "temporary whitelist write");
  if (!temporaryWhitelistActivityCache.has(id)) {
    throw new Error(`Identity ${id} must be prefetched before a temporary whitelist mutation.`);
  }
  if (activity !== null) {
    assertTemporaryWhitelistActivity(activity, `temporary_whitelist_entries[${id}]`);
  }
  if (!Number.isSafeInteger(temporaryWhitelistWriteRevision.current + 1)) {
    throw new Error("Temporary whitelist revision space is exhausted.");
  }
  temporaryWhitelistWriteRevision.current++;
  const revision: number = temporaryWhitelistWriteRevision.current;
  temporaryWhitelistActivityCache.set(id, activity);
  unacknowledgedTemporaryWhitelistWrites.set(id, { activity, revision });
  const message: TemporaryWhitelistWriteDiskMessage = {
    type: "temporaryWhitelistWrite",
    id,
    activity,
    revision,
  };
  if (diskIO.postDiskIO(message)) return true;
  logger.error(
    `Failed to queue temporary whitelist identity ${id}; retaining revision ${revision} for replay.`
  );
  return false;
}

/**
 * 计入一条已通过入口门禁的群发言；冷缺失时 fail closed，不创建猜测记录。
 *
 * 状态机原样返回入参（当天已达标后的稳态）时没有新事实要落盘：跳过 revision
 * 递增、LRU 写、未 ACK 记账与一次到 Disk I/O 线程的 structured clone，`queued`
 * 仍为 true。这一路同时跳过 `LruCache.set` 的热度刷新，因此调用方必须在同一条
 * 消息上先经 `hasActiveTemporaryWhitelistAt` 读过该主键，由那次 `get` 维持热度。
 */
export function recordTemporaryWhitelistActivity(
  id: number,
  now: number = Date.now()
): RecordedTemporaryWhitelistActivity | undefined {
  if (!temporaryWhitelistActivityCache.has(id)) return undefined;
  const current: Readonly<TemporaryWhitelistActivity> | null =
    temporaryWhitelistActivityCache.peek(id) ?? null;
  const activity: Readonly<TemporaryWhitelistActivity> =
    advanceTemporaryWhitelistActivity(current, now);
  if (activity === current) return { activity, queued: true };
  return {
    activity,
    queued: queueTemporaryWhitelistWrite(id, activity),
  };
}

/** 广告判定为 true 时删除整条累计；不存在时幂等成功。 */
export function clearTemporaryWhitelistActivity(id: number): boolean {
  const cached: boolean = temporaryWhitelistActivityCache.has(id);
  if (cached && temporaryWhitelistActivityCache.peek(id) === null) return true;
  // 删除不依赖旧值。冷读失败时仍发布墓碑并保留到 ACK，避免一次 Disk I/O
  // 自愈窗口让已经确证的 ad=true 累计继续存活。
  if (!cached) temporaryWhitelistActivityCache.set(id, null);
  return queueTemporaryWhitelistWrite(id, null);
}

function settleTemporaryWhitelistWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.temporaryWhitelistWrites) {
    if (
      unacknowledgedTemporaryWhitelistWrites.get(persisted.id)?.revision ===
      persisted.revision
    ) {
      unacknowledgedTemporaryWhitelistWrites.delete(persisted.id);
    }
  }
}

function replayTemporaryWhitelistWrites(transport: DiskIORecoveryTransport): boolean {
  const now: number = Date.now();
  const writes: readonly (readonly [number, UnacknowledgedTemporaryWhitelistWrite])[] =
    [...unacknowledgedTemporaryWhitelistWrites.entries()].sort(
      (
        left: readonly [number, UnacknowledgedTemporaryWhitelistWrite],
        right: readonly [number, UnacknowledgedTemporaryWhitelistWrite]
      ): number => left[1].revision - right[1].revision
    );
  for (const [id, change] of writes) {
    const activity: Readonly<TemporaryWhitelistActivity> | null =
      change.activity !== null &&
        isTemporaryWhitelistActivityRetained(change.activity, now)
        ? change.activity
        : null;
    if (activity !== change.activity) {
      const normalized: UnacknowledgedTemporaryWhitelistWrite = {
        activity,
        revision: change.revision,
      };
      unacknowledgedTemporaryWhitelistWrites.set(id, normalized);
      temporaryWhitelistActivityCache.set(id, activity);
    }
    if (!transport.post({
      type: "temporaryWhitelistWrite",
      id,
      activity,
      revision: change.revision,
    } satisfies TemporaryWhitelistWriteDiskMessage)) return false;
  }
  return true;
}

diskIO.onIdentityStoragePersisted(settleTemporaryWhitelistWrites);
diskIO.onDiskIORespawn(
  "temporary whitelist",
  DISK_IO_RESPAWN_PRIORITIES.TEMPORARY_WHITELIST,
  replayTemporaryWhitelistWrites
);
