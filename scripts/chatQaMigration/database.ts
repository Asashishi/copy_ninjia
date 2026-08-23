/** 共享 SQLite 的 v4/v5 谱系检查与迁移后核验。 */

import {
  IDENTITY_DATABASE_CHAT_QA_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_CHAT_QA_MIGRATION_HASH,
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH,
} from "../../packages/consts/identityStorage";
import {
  assertStorageDatabaseJsonbStorage,
  readStorageDatabaseBaseRows,
  readStorageDatabaseRows,
} from "../../packages/database/interact/inspection";
import {
  migrateStorageDatabaseSchema,
  readStorageDatabaseMigrationJournal,
} from "../../packages/database/interact/migration";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatQa,
  decodeStoredChatStates,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  storageRowSource,
  validateStoredIdentityPolicies,
} from "../../packages/database/validation/storageRows";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  parseIdentityMetadata,
} from "../../packages/database/codec/identity";
import { parseJsonInput } from "../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../packages/libs/record";
import type { ValidatedIdentityPolicyRows } from
  "../../packages/database/validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseBaseRows,
  StorageDatabaseMigrationJournalEntry,
  StorageDatabaseRows,
} from "../../packages/types/storageDatabase";

/** 本条冷迁移边两端的 schema 版本；除这两个值以外一律拒绝。 */
export type ChatQaSchemaVersion = 4 | 5;

/** 本次冷迁移唯一覆盖的来源版本；更旧的库必须先分阶段升到这一版。 */
const PREVIOUS_SCHEMA_VERSION: ChatQaSchemaVersion = 4;

/** 本次冷迁移的目标版本，与 IDENTITY_DATABASE_SCHEMA_VERSION 同步。 */
export const CURRENT_SCHEMA_VERSION: ChatQaSchemaVersion = 5;

/** 一次检查得到的库形态；`version` 决定还要不要迁。 */
export interface ChatQaDatabaseInspection {
  readonly version: ChatQaSchemaVersion;
  readonly baseRows: StorageDatabaseBaseRows;
}

/** 迁移状态；`alreadyMigrated` 表示这个库已经是当前 schema。 */
export type ChatQaMigrationStatus = "pending" | "alreadyMigrated";

/**
 * v4 库里白名单权限对象的**历史**键集合，逐字抄自 0003 migration 的回填条件。
 *
 * 不从 WHITELIST_PERMISSION_KEYS 推导（哪怕只是减掉新键）：那份常量是「当前」
 * 的键集合，将来再加一个键，这里的推导会跟着变，于是这条历史边的判定被悄悄
 * 改写。迁移前的形态是既成事实，只能写死。
 */
const SCHEMA_V4_PERMISSION_KEYS: readonly string[] = [
  "isCanMute",
  "isCanUnMute",
  "isCanGag",
  "isCanViewBotStatus",
  "isCanBlock",
  "isCanUnBlock",
  "isCanWhiteOther",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanBypassFloodControl",
  "isCanControllAIPermission",
  "isCanControllAdDetectPermission",
  "isCanControllFloodControlPermission",
  "isCanControllJATranslatePermission",
  "isCanControllAntiRaidPermission",
];

/**
 * 按 v4 的键集合校验两张名单。
 *
 * 迁移**前**不能用生产解码器：那份解码器已经按 v5 要求 `isCanControllQaPermission`
 * 存在，而真正的 v4 行里根本没有这个键——拿它去校验，任何一个待迁库都会在迁移
 * 开始之前被判成非法，而报错还会指向一个部署方从没写过的字段。
 */
function assertLegacyV4IdentityPolicies(
  rows: StorageDatabaseBaseRows,
  source: string
): ValidatedIdentityPolicyRows {
  const whitelistIds: Set<number> = new Set<number>();
  const blocklistIds: Set<number> = new Set<number>();
  for (const row of rows.whitelist) {
    const path: string = storageRowSource(source, "whitelist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    const value: unknown = parseJsonInput(row.data, path);
    if (!isPlainRecord(value) || !hasExactKeys(value, ["permissions", "meta"])) {
      throw new Error(`${path}: expected an object with permissions and meta.`);
    }
    const permissions: unknown = value.permissions;
    if (
      !isPlainRecord(permissions) ||
      !hasExactKeys(permissions, SCHEMA_V4_PERMISSION_KEYS)
    ) {
      throw new Error(`${path}.permissions: expected exactly the schema v4 permission keys.`);
    }
    for (const key of SCHEMA_V4_PERMISSION_KEYS) {
      if (typeof permissions[key] !== "boolean") {
        throw new Error(`${path}.permissions.${key}: expected a boolean.`);
      }
    }
    // metadata 不随 schema 版本变化，用生产解析器：`--check` 必须拦下
    // `--apply` 之后的严格校验会拒绝的一切，否则坏行要等库改完才暴露。
    parseIdentityMetadata(value.meta, path, "$.meta");
    whitelistIds.add(row.id);
  }
  for (const row of rows.blocklist) {
    const path: string = storageRowSource(source, "blocklist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    // 黑名单结构不受本次迁移影响，直接复用生产解码器。
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

function isMigrationEntry(
  entry: StorageDatabaseMigrationJournalEntry | undefined,
  createdAt: number,
  hash: string
): boolean {
  return entry?.createdAt === createdAt && entry.hash === hash;
}

/**
 * v4 谱系：最后一条必须正好是群状态表那次 migration。
 *
 * 只认末位而不逐条比对更早的历史：更早那几条已经由「这个库当前是 v4」这个
 * 事实归纳保证——库能报出 v4，就说明它当初通过了 v4 那一版的谱系检查。
 * 本脚本按约定只覆盖 v4 → v5 这一条边，不重新实现更早的历史判定。
 */
function isSchemaV4Journal(
  rows: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  return rows.length >= 1 && isMigrationEntry(
    rows.at(-1),
    IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
    IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH
  );
}

/** v5 谱系：在 v4 之后再多出问答表那一条，且必须是末位。 */
function isSchemaV5Journal(
  rows: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  return rows.length >= 2 &&
    isMigrationEntry(
      rows.at(-1),
      IDENTITY_DATABASE_CHAT_QA_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CHAT_QA_MIGRATION_HASH
    ) &&
    isSchemaV4Journal(rows.slice(0, -1));
}

/**
 * 识别当前库是待迁的 v4 还是已完成的 v5，未知历史一律拒绝。
 *
 * 先做整库 JSONB 与业务行严格解码，再看版本：一个内容已经坏掉的库不该因为
 * 版本号对得上就被放进迁移事务。
 */
export function inspectChatQaDatabase(
  database: StorageDatabase,
  source: string
): ChatQaDatabaseInspection {
  const baseRows: StorageDatabaseBaseRows = readStorageDatabaseBaseRows(database);
  // 版本要先读：白名单的合法形态本身随版本而变，用错那一套就会在迁移前
  // 把一个完好的待迁库判成损坏。
  const version: number = readStorageSchemaVersion(baseRows, source);
  const policies: ValidatedIdentityPolicyRows = version === CURRENT_SCHEMA_VERSION
    ? validateStoredIdentityPolicies(baseRows, source)
    : assertLegacyV4IdentityPolicies(baseRows, source);
  assertPendingRemovalBlocklistReferences(
    decodeStoredPendingRemovals(baseRows.removals, source).values,
    policies.blocklistIds,
    source
  );
  const journal: readonly StorageDatabaseMigrationJournalEntry[] =
    readStorageDatabaseMigrationJournal(database);
  if (version === CURRENT_SCHEMA_VERSION) {
    if (!isSchemaV5Journal(journal)) {
      throw new Error(`${source}: storage database reports v5 with an unrecognised migration lineage.`);
    }
    return { version: CURRENT_SCHEMA_VERSION, baseRows };
  }
  if (version !== PREVIOUS_SCHEMA_VERSION) {
    throw new Error(
      `${source}: cold migration only covers schema v${PREVIOUS_SCHEMA_VERSION} -> ` +
      `v${CURRENT_SCHEMA_VERSION}; this database reports v${version}. Upgrade it to ` +
      `v${PREVIOUS_SCHEMA_VERSION} on the release that shipped that migration first.`
    );
  }
  if (!isSchemaV4Journal(journal)) {
    throw new Error(`${source}: storage database reports v4 with an unrecognised migration lineage.`);
  }
  return { version: PREVIOUS_SCHEMA_VERSION, baseRows };
}

/** 迁移前后都要成立的整库不变量；迁移只加表和补一个权限键，业务行不该变。 */
export function assertChatQaMigrationResult(
  database: StorageDatabase,
  source: string,
  before: StorageDatabaseBaseRows
): void {
  assertStorageDatabaseJsonbStorage(database, source);
  const rows: StorageDatabaseRows = readStorageDatabaseRows(database);
  const version: number = readStorageSchemaVersion(rows, source);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`${source}: schema version must be ${CURRENT_SCHEMA_VERSION} after migration.`);
  }
  if (!isSchemaV5Journal(readStorageDatabaseMigrationJournal(database))) {
    throw new Error(`${source}: migration lineage must end at the chat_qa migration.`);
  }
  // 行数守恒：本次迁移只 CREATE TABLE 并给每条白名单补一个布尔键，任何一张
  // 业务表的行数变化都说明迁移动了不该动的东西。
  if (
    rows.whitelist.length !== before.whitelist.length ||
    rows.blocklist.length !== before.blocklist.length ||
    rows.removals.length !== before.removals.length
  ) {
    throw new Error(`${source}: migration must not add or remove identity policy rows.`);
  }
  if (rows.chatQa.length !== 0) {
    throw new Error(`${source}: chat_qa must be empty immediately after the migration.`);
  }
  // 逐行重新严格解码：白名单条目刚被 jsonb_set 改过，新键必须是合法布尔，
  // 群状态与问答一并复核，确保新 schema 下整库仍然可读。
  validateStoredIdentityPolicies(rows, source);
  decodeStoredChatStates(rows.chatStates, source);
  decodeStoredChatQa(rows.chatQa, source);
}

/** 在已备份的库上执行 schema migration；生产启动路径永远不会调到这里。 */
export function applyChatQaMigration(database: StorageDatabase): void {
  migrateStorageDatabaseSchema(database);
}
