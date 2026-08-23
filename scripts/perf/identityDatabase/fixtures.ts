import { DEFAULT_WHITELIST_PERMISSIONS } from
  "../../../packages/consts/whitelist";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import type {
  BlocklistEntryData,
  WhitelistEntryData,
} from "../../../packages/types/identityPolicy";
import type { StorageDatabaseChange } from
  "../../../packages/types/storageDatabase";

/** 身份写入与 LRU 基准共用的固定白名单条目。 */
export const WHITE_ENTRY: Readonly<WhitelistEntryData> = {
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: { firstName: "benchmark", lastName: "", username: "" },
};

/** 身份读取与 LRU 基准共用的固定黑名单条目。 */
export const BLACK_ENTRY: Readonly<BlocklistEntryData> = {
  blockedAt: "2026/08/11 00:00:00",
  meta: { firstName: "benchmark", lastName: "", username: "" },
};

/** SQLite 白名单 fixture 使用的稳定 JSONB 载荷。 */
export const WHITE_DATA: string = encodeWhitelistEntryData(WHITE_ENTRY);

/** SQLite 黑名单 fixture 使用的稳定 JSONB 载荷。 */
export const BLACK_DATA: string = encodeBlocklistEntryData(BLACK_ENTRY);

/** 写基准只修改 whitelist，其他域共用同一个只读空变更集。 */
export const EMPTY_STORAGE_CHANGES:
ReadonlyMap<number, StorageDatabaseChange> =
  new Map<number, StorageDatabaseChange>();

/**
 * 问答表的空变更集合；本基准不写它，但事务入口按表要求全量给齐。
 * 与 EMPTY_STORAGE_CHANGES 同理共享同一个实例，不在每次调用现造。
 */
export const EMPTY_CHAT_QA_CHANGES:
ReadonlyMap<number, ReadonlyMap<string, StorageDatabaseChange>> =
  new Map<number, ReadonlyMap<string, StorageDatabaseChange>>();
