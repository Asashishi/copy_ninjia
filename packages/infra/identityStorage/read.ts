import * as diskIO from "../diskIO";
import {
  blocklistEntryCache,
  identityEntryCounts,
  whitelistEntryCache,
} from "../../cache/main/identityStorage";
import { temporaryAdBypassActivityCache } from
  "../../cache/main/temporaryAdBypass";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from
  "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../database/codec/identity";
import { logger } from "../logger";
import {
  hydrateTemporaryAdBypassActivities,
  isTemporaryAdBypassActivityCached,
} from "../identityPolicy/temporaryAdBypass";
import {
  currentIdentityPolicyText,
  rawIdentityPolicyRows,
} from "./shared";
import type { CachedUser } from "../../types/chatState";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type {
  IdentityPolicyRawReadResult,
  IdentityPolicyVerdicts,
} from "../../types/identityStorage";

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

/**
 * 启动恢复只灌入数据库计数，不把 SQLite 整表复制到主线程。
 *
 * 两个计数都通过校验后才清空三份读取 LRU 并写入计数；三类未 ACK 最终值与
 * revision 发号器不在这里改动，它们只随进程全新初始化清空。
 */
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
  temporaryAdBypassActivityCache.clear();
  identityEntryCounts.whitelist = whitelistCount;
  identityEntryCounts.blocklist = blocklistCount;
}

/** 三份 LRU 是否都已有该主键的正/负结论；热 update 据此避免临时数组。 */
export function isIdentityPolicyCached(id: number): boolean {
  return whitelistEntryCache.has(id) &&
    blocklistEntryCache.has(id) &&
    isTemporaryAdBypassActivityCached(id);
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

/** 结论收集器；readIdentityPolicyVerdicts 逐块累加，预热路径不传。 */
interface IdentityPolicyVerdictSets {
  readonly whitelisted: Set<number>;
  readonly blocked: Set<number>;
}

/**
 * 读取一块主键并写入三份 LRU；传入 verdicts 时同时把本块结论记进调用方的局部集合。
 * 本地未 ACK 最终值覆盖数据库迟到结果。
 */
async function readIdentityPolicyChunk(
  ids: readonly number[],
  verdicts?: IdentityPolicyVerdictSets
): Promise<void> {
  const reply: IdentityPolicyRawReadResult = await diskIO.readIdentityPolicies(ids);
  const requested: Set<number> = new Set(ids);
  const whitelistRows: Map<number, string> = rawIdentityPolicyRows(
    reply.whitelist,
    requested,
    "whitelist"
  );
  const blocklistRows: Map<number, string> = rawIdentityPolicyRows(
    reply.blocklist,
    requested,
    "blocklist"
  );
  hydrateTemporaryAdBypassActivities(reply.temporaryAdBypass, requested, ids);
  for (const id of ids) {
    const whitelistText: string | null = currentIdentityPolicyText(
      "whitelist",
      id,
      whitelistRows.get(id)
    );
    const blocklistText: string | null = currentIdentityPolicyText(
      "blocklist",
      id,
      blocklistRows.get(id)
    );
    if (whitelistText !== null && blocklistText !== null) {
      throw new Error(`Identity ${id} exists in both whitelist and blocklist views.`);
    }
    if (verdicts !== undefined) {
      if (whitelistText !== null) verdicts.whitelisted.add(id);
      if (blocklistText !== null) verdicts.blocked.add(id);
    }
    whitelistEntryCache.set(
      id,
      whitelistText === null
        ? null
        : decodeWhitelistEntryData(
          whitelistText,
          `permission_list[${id}].policy`
        )
    );
    blocklistEntryCache.set(
      id,
      blocklistText === null
        ? null
        : decodeBlocklistEntryData(
          blocklistText,
          `blocklist_entries[${id}].data`
        )
    );
  }
}

/**
 * 批量预热三份 LRU 的冷缺失；本地未 ACK 最终值覆盖数据库迟到结果。
 * 已缓存的主键按一次使用刷新热度，保证它们不会被同一次预热写入的冷键挤出
 * （单块严格小于 LRU 容量，见 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。
 * 未初始化 Disk I/O 时只可能是独立单测，保持同步读取的 fail-closed 语义。
 * 冷读失败就地降级，避免 update 前置预热把 Worker 自愈窗口放大为重启循环。
 * @returns true 表示没有冷读失败；破坏性批量路径必须在 false 时放弃执行。
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
    if (
      !whitelistEntryCache.has(id) ||
      !blocklistEntryCache.has(id) ||
      !isTemporaryAdBypassActivityCached(id)
    ) {
      missing.push(id);
    } else {
      whitelistEntryCache.get(id);
      blocklistEntryCache.get(id);
      temporaryAdBypassActivityCache.get(id);
    }
  }
  if (
    missing.length === 0 ||
    diskIO.isDiskIOInitialized() !== true
  ) return true;
  for (
    let index: number = 0;
    index < missing.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await readIdentityPolicyChunk(
        missing.slice(index, index + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES)
      );
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

/**
 * 为破坏性批量处置直接冷读一批主键的永久策略结论，不论它们此刻是否已缓存。
 *
 * 结论由调用方局部持有，处置期间其它流量造成的 LRU 淘汰不会把白名单身份变成
 * 「冷缺失即不存在」；读取同时写入三份 LRU，供处置中的实时复核继续命中。
 * 本地未 ACK 最终值覆盖数据库迟到结果；Disk I/O 不可用时按读取失败处理。
 * @returns 读取失败时为 null，调用方必须放弃本批处置。
 */
export async function readIdentityPolicyVerdicts(
  candidateIds: readonly number[]
): Promise<IdentityPolicyVerdicts | null> {
  const ids: number[] = [];
  const seen: Set<number> = new Set();
  for (const id of candidateIds) {
    assertTelegramIdentityId(id, "identity policy verdict read");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const verdicts: IdentityPolicyVerdictSets = { whitelisted: new Set(), blocked: new Set() };
  for (
    let index: number = 0;
    index < ids.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await readIdentityPolicyChunk(
        ids.slice(index, index + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES),
        verdicts
      );
    } catch (error: unknown) {
      logger.error(
        `Failed to read identity policy verdicts for ${ids.length} identity(ies):`,
        error
      );
      return null;
    }
  }
  return verdicts;
}
