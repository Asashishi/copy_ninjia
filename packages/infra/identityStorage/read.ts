import {
  blocklistEntryCache,
  identityEntryCounts,
  whitelistEntryCache,
} from "../../cache/main/identityStorage";
import { resetTemporaryWhitelistCache } from
  "../../cache/main/temporaryWhitelist";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from
  "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../database/codec/identity";
import { logger } from "../logger";
import {
  hydrateTemporaryWhitelistActivities,
  isTemporaryWhitelistActivityCached,
} from "../identityPolicy/temporaryWhitelist";
import {
  currentIdentityPolicyText,
  identityDiskIOApi,
  rawIdentityPolicyRows,
} from "./shared";
import type { CachedUser } from "../../types/chatState";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type { IdentityPolicyRawReadResult } from
  "../../types/identityStorage";
import type { IdentityDiskIOApi } from "./shared";

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

/** 启动恢复只灌入数据库计数，不把 SQLite 整表复制到主线程。 */
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
  resetTemporaryWhitelistCache();
  identityEntryCounts.whitelist = whitelistCount;
  identityEntryCounts.blocklist = blocklistCount;
}

/** 三份 LRU 是否都已有该主键的正/负结论；热 update 据此避免临时数组。 */
export function isIdentityPolicyCached(id: number): boolean {
  return whitelistEntryCache.has(id) &&
    blocklistEntryCache.has(id) &&
    isTemporaryWhitelistActivityCached(id);
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

async function prefetchChunk(ids: readonly number[]): Promise<void> {
  const read: IdentityDiskIOApi["readIdentityPolicies"] =
    identityDiskIOApi.readIdentityPolicies;
  if (read === undefined) return;
  const reply: IdentityPolicyRawReadResult = await read(ids);
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
  hydrateTemporaryWhitelistActivities(reply.temporaryWhitelist, requested, ids);
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
    whitelistEntryCache.set(
      id,
      whitelistText === null
        ? null
        : decodeWhitelistEntryData(
          whitelistText,
          `whitelist_entries[${id}].data`
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
      !isTemporaryWhitelistActivityCached(id)
    ) missing.push(id);
  }
  if (
    missing.length === 0 ||
    identityDiskIOApi.isDiskIOInitialized?.() !== true
  ) return true;
  for (
    let index: number = 0;
    index < missing.length;
    index += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    try {
      await prefetchChunk(
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
