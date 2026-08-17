import { IDENTITY_DATABASE_SCHEMA_KEY } from "../../consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { assertTelegramChatId, decodeChatStateData } from "../codec/chatState";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
} from "../codec/identity";
import { parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type {
  StorageDatabaseBaseRows,
  StoredChatStateRow,
  StoredPendingRemovalRow,
} from "../../types/storageDatabase";

/** 统一生成 SQLite 业务行的安全来源路径，不包含行内容。 */
export function storageRowSource(
  source: string,
  table: string,
  id: number | string
): string {
  return `${source}:${table}[${String(id)}].data`;
}

/** 严格读取唯一 schema-version 元数据行，版本范围由调用生命周期决定。 */
export function readStorageSchemaVersion(
  rows: Pick<StorageDatabaseBaseRows, "metadata">,
  source: string
): number {
  if (
    rows.metadata.length !== 1 ||
    rows.metadata[0]?.key !== IDENTITY_DATABASE_SCHEMA_KEY
  ) {
    throw new Error(`${source}: storage_metadata must contain exactly one schema-version row.`);
  }
  const value: unknown = parseJsonInput(
    rows.metadata[0].data,
    storageRowSource(source, "storage_metadata", IDENTITY_DATABASE_SCHEMA_KEY)
  );
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version"]) ||
    !Number.isSafeInteger(value.version)
  ) {
    throw new Error(
      `${source}: storage_metadata schema-version must contain one safe integer version.`
    );
  }
  return value.version as number;
}

/** 黑白名单校验后的主键集合；待踢 outbox 以黑名单集合校验引用完整性。 */
export interface ValidatedIdentityPolicyRows {
  readonly whitelistIds: ReadonlySet<number>;
  readonly blocklistIds: ReadonlySet<number>;
}

/** 严格解码两张名单并拒绝跨表重复身份。 */
export function validateStoredIdentityPolicies(
  rows: StorageDatabaseBaseRows,
  source: string
): ValidatedIdentityPolicyRows {
  const whitelistIds: Set<number> = new Set<number>();
  const blocklistIds: Set<number> = new Set<number>();
  for (const row of rows.whitelist) {
    const path: string = storageRowSource(source, "whitelist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeWhitelistEntryData(row.data, path);
    whitelistIds.add(row.id);
  }
  for (const row of rows.blocklist) {
    const path: string = storageRowSource(source, "blocklist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeBlocklistEntryData(row.data, path);
    if (whitelistIds.has(row.id)) {
      throw new Error(
        `${source}: identity ${row.id} exists in both whitelist_entries and blocklist_entries.`
      );
    }
    blocklistIds.add(row.id);
  }
  return { whitelistIds, blocklistIds };
}

/** 待踢行校验结果同时保留规范文本，供 Worker 快照 diff 避免重复编码。 */
export interface DecodedPendingRemovalRows {
  readonly values: ReadonlyMap<number, PendingBlockedRemoval>;
  readonly encoded: ReadonlyMap<number, string>;
}

/** 严格解码待踢 outbox 自身；跨名单引用只由冷迁移额外核对。 */
export function decodeStoredPendingRemovals(
  rows: readonly StoredPendingRemovalRow[],
  source: string
): DecodedPendingRemovalRows {
  const values: Map<number, PendingBlockedRemoval> = new Map();
  const encoded: Map<number, string> = new Map();
  for (const row of rows) {
    const path: string = storageRowSource(
      source,
      "pending_blocked_removals",
      row.removalId
    );
    if (!Number.isSafeInteger(row.removalId) || row.removalId < 1) {
      throw new Error(`${path}: removal_id must be a positive safe integer.`);
    }
    const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(row.data, path);
    if (pending.params.removalId !== row.removalId) {
      throw new Error(`${path}: params.removalId must equal the row primary key.`);
    }
    values.set(row.removalId, pending);
    // pending 已由上面的严格 decoder 规范化；这里直接生成与 encoder 相同的稳定
    // 文本，避免为了取得文本把刚解出的同一个值再 parse 和逐字段校验一遍。
    encoded.set(row.removalId, JSON.stringify(pending));
  }
  return { values, encoded };
}

/** 冷迁移核对 outbox 引用；生产启动不得为此读取完整黑名单主键。 */
export function assertPendingRemovalBlocklistReferences(
  removals: ReadonlyMap<number, PendingBlockedRemoval>,
  blocklistIds: ReadonlySet<number>,
  source: string
): void {
  for (const [removalId, pending] of removals) {
    const path: string = storageRowSource(
      source,
      "pending_blocked_removals",
      removalId
    );
    if (pending.params.probeMembership) {
      if (blocklistIds.size === 0) {
        throw new Error(`${path}: sweep requires at least one blocklist entry.`);
      }
    } else if (pending.params.userIds.some(
      (id: number): boolean => !blocklistIds.has(id)
    )) {
      throw new Error(`${path}: frozen userIds must all exist in blocklist_entries.`);
    }
  }
}

/** 严格解码群状态，并执行 25 群硬顶与唯一代理目标约束。 */
export function decodeStoredChatStates(
  rows: readonly StoredChatStateRow[],
  source: string
): Map<number, ChatState> {
  if (rows.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${source}:chat_states must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
      "delete chats that are no longer managed before starting the bot."
    );
  }
  const chatStates: Map<number, ChatState> = new Map();
  let proxyTargetChatId: number | undefined;
  for (const row of rows) {
    const path: string = storageRowSource(source, "chat_states", row.chatId);
    assertTelegramChatId(row.chatId, path);
    if (chatStates.has(row.chatId)) {
      throw new Error(`${path}: duplicate chat primary key.`);
    }
    const state: ChatState = decodeChatStateData(row.data, path);
    if (state.isProxySendEnabled === true) {
      if (proxyTargetChatId !== undefined) {
        throw new Error(
          `${source}:chat_states must contain at most one active proxy send target.`
        );
      }
      proxyTargetChatId = row.chatId;
    }
    chatStates.set(row.chatId, state);
  }
  return chatStates;
}

/** 生产启动信任当前 SQLite 写入边界，只解析群状态 JSON 以恢复热缓存。 */
export function restoreStoredChatStates(
  rows: readonly StoredChatStateRow[],
  source: string
): Map<number, ChatState> {
  const chatStates: Map<number, ChatState> = new Map();
  for (const row of rows) {
    const path: string = storageRowSource(source, "chat_states", row.chatId);
    const state: ChatState = parseJsonInput(row.data, path) as ChatState;
    chatStates.set(row.chatId, state);
  }
  return chatStates;
}
