/**
 * 身份库 schema v2 -> v3 的显式手工迁移：新增 isCanWhiteOther。
 *
 * 只有 `--apply` 才写库；执行前必须停服务。本脚本取得进程锁、在工作树外保存
 * SQLite 一致性快照与权限/属主/哈希清单，再执行 Drizzle migration 并严格复核。
 * 备份无论成功失败都保留，由部署方完成上线核验后手工删除。
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_TOKEN } from "../packages/config/telegram";
import {
  IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
} from "../packages/consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../packages/consts/paths";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
} from "../packages/database/codec/identity";
import {
  assertIdentityDatabaseIntegrity,
  assertIdentityDatabaseJsonbStorage,
  closeIdentityDatabase,
  migrateIdentityDatabaseSchema,
  openIdentityDatabase,
  readIdentityDatabaseMigrationJournal,
  readIdentityDatabaseRows,
  serializeIdentityDatabaseSnapshot,
} from "../packages/database/interact/identity";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from
  "../packages/infra/storage/instanceLock";
import { parseJsonInput } from "../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../packages/libs/record";
import type {
  IdentityDatabase,
  IdentityDatabaseMigrationJournalEntry,
  IdentityDatabaseRows,
  StoredIdentityPolicyRow,
} from "../packages/types/identityDatabase";
import type { PendingBlockedRemoval } from "../packages/types/blocklist";

/** 本次手工迁移唯一接受的旧身份库 schema 版本。 */
const PREVIOUS_SCHEMA_VERSION: number = 2;
/** schema v2 权限对象的完整键集，用于在写库前拒绝残缺或未知结构。 */
const PREVIOUS_PERMISSION_KEYS: readonly string[] = [
  "isCanMute",
  "isCanUnMute",
  "isCanGag",
  "isCanViewBotStatus",
  "isCanBlock",
  "isCanUnBlock",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanBypassFloodControl",
  "isCanControllAIPermission",
  "isCanControllAdDetectPermission",
  "isCanControllFloodControlPermission",
  "isCanControllJATranslatePermission",
  "isCanControllAntiRaidPermission",
];

interface BackupManifest {
  readonly sourcePath: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
}

type WhitelistRowValidator = (row: StoredIdentityPolicyRow) => void;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fsyncPath(path: string): void {
  const fd: number = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function schemaVersion(rows: IdentityDatabaseRows): number {
  if (
    rows.metadata.length !== 1 ||
    rows.metadata[0]?.key !== IDENTITY_DATABASE_SCHEMA_KEY
  ) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: storage_metadata must contain exactly one schema-version row.`);
  }
  const value: unknown = parseJsonInput(
    rows.metadata[0].data,
    `${IDENTITY_DATABASE_PATH}:storage_metadata[schema-version].data`
  );
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version"]) ||
    !Number.isSafeInteger(value.version)
  ) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: storage_metadata schema-version must contain one safe integer version.`);
  }
  return value.version as number;
}

function isMigrationEntry(
  entry: IdentityDatabaseMigrationJournalEntry | undefined,
  createdAt: number,
  hash: string
): boolean {
  return entry?.createdAt === createdAt && entry.hash === hash;
}

function isPreviousMigrationJournal(
  rows: readonly IdentityDatabaseMigrationJournalEntry[]
): boolean {
  return rows.length === 2 &&
    isMigrationEntry(
      rows[0],
      IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_TEXT_MIGRATION_HASH
    ) &&
    isMigrationEntry(
      rows[1],
      IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_JSONB_MIGRATION_HASH
    );
}

function isCurrentMigrationJournal(
  rows: readonly IdentityDatabaseMigrationJournalEntry[]
): boolean {
  const permissionIndex: number = rows.length - 1;
  const hasPermissionMigration: boolean = isMigrationEntry(
    rows[permissionIndex],
    IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
    IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH
  );
  if (!hasPermissionMigration) return false;
  if (rows.length === 2) {
    return isMigrationEntry(
      rows[0],
      IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH
    );
  }
  return rows.length === 3 && isPreviousMigrationJournal(rows.slice(0, 2));
}

function rowSource(table: string, id: number): string {
  return `${IDENTITY_DATABASE_PATH}:${table}[${id}].data`;
}

function validateIdentityRows(
  rows: IdentityDatabaseRows,
  validateWhitelistRow: WhitelistRowValidator
): void {
  const whitelistIds: Set<number> = new Set<number>();
  const blocklistIds: Set<number> = new Set<number>();
  for (const row of rows.whitelist) {
    assertTelegramIdentityId(row.id, rowSource("whitelist_entries", row.id));
    validateWhitelistRow(row);
    whitelistIds.add(row.id);
  }
  for (const row of rows.blocklist) {
    const source: string = rowSource("blocklist_entries", row.id);
    assertTelegramIdentityId(row.id, source);
    decodeBlocklistEntryData(row.data, source);
    if (whitelistIds.has(row.id)) {
      throw new Error(`${IDENTITY_DATABASE_PATH}: identity ${row.id} exists in both whitelist_entries and blocklist_entries.`);
    }
    blocklistIds.add(row.id);
  }
  for (const row of rows.removals) {
    const source: string = rowSource(
      "pending_blocked_removals",
      row.removalId
    );
    if (!Number.isSafeInteger(row.removalId) || row.removalId < 1) {
      throw new Error(`${source}: removal_id must be a positive safe integer.`);
    }
    const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
      row.data,
      source
    );
    if (pending.params.removalId !== row.removalId) {
      throw new Error(`${source}: params.removalId must equal the row primary key.`);
    }
    if (pending.params.probeMembership) {
      if (blocklistIds.size === 0) {
        throw new Error(`${source}: sweep requires at least one blocklist entry.`);
      }
    } else if (pending.params.userIds.some(
      (id: number): boolean => !blocklistIds.has(id)
    )) {
      throw new Error(`${source}: frozen userIds must all exist in blocklist_entries.`);
    }
  }
}

function validateCurrentWhitelistRow(row: StoredIdentityPolicyRow): void {
  decodeWhitelistEntryData(
    row.data,
    rowSource("whitelist_entries", row.id)
  );
}

function validateCurrentDatabase(database: IdentityDatabase): void {
  assertIdentityDatabaseIntegrity(database);
  assertIdentityDatabaseJsonbStorage(database, IDENTITY_DATABASE_PATH);
  const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
  if (schemaVersion(rows) !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: schema migration did not reach version ${IDENTITY_DATABASE_SCHEMA_VERSION}.`
    );
  }
  const journal: readonly IdentityDatabaseMigrationJournalEntry[] =
    readIdentityDatabaseMigrationJournal(database);
  if (!isCurrentMigrationJournal(journal)) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: Drizzle migration journal does not match a supported schema v3 lineage.`);
  }
  validateIdentityRows(rows, validateCurrentWhitelistRow);
}

function validatePreviousWhitelistRow(row: StoredIdentityPolicyRow): void {
  const source: string =
    `${IDENTITY_DATABASE_PATH}:whitelist_entries[${row.id}].data`;
  const value: unknown = parseJsonInput(row.data, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, ["permissions", "meta"])) {
    throw new Error(`${source}: $ must use the complete v2 whitelist entry shape.`);
  }
  if (
    !isPlainRecord(value.permissions) ||
    !hasExactKeys(value.permissions, PREVIOUS_PERMISSION_KEYS)
  ) {
    throw new Error(`${source}: $.permissions must use the complete v2 permission shape.`);
  }
  for (const key of PREVIOUS_PERMISSION_KEYS) {
    if (typeof value.permissions[key] !== "boolean") {
      throw new Error(`${source}: $.permissions.${key} must be a boolean.`);
    }
  }
  if (
    !isPlainRecord(value.meta) ||
    !hasExactKeys(value.meta, ["firstName", "lastName", "username"]) ||
    typeof value.meta.firstName !== "string" ||
    typeof value.meta.lastName !== "string" ||
    typeof value.meta.username !== "string"
  ) {
    throw new Error(`${source}: $.meta must contain firstName, lastName, and username strings.`);
  }
}

function validatePreviousDatabaseRows(rows: IdentityDatabaseRows): void {
  validateIdentityRows(rows, validatePreviousWhitelistRow);
}

function createExternalBackup(database: IdentityDatabase): string {
  const root: string = mkdtempSync(join(
    tmpdir(),
    "copy-ninjia-whitelist-permission-"
  ));
  const backupPath: string = join(root, "storage.sqlite");
  const manifestPath: string = join(root, "manifest.json");
  const snapshot: Uint8Array = serializeIdentityDatabaseSnapshot(database);
  const sourceStats: ReturnType<typeof statSync> = statSync(
    IDENTITY_DATABASE_PATH
  );
  writeFileSync(backupPath, snapshot, { mode: 0o600, flag: "wx" });
  const manifest: BackupManifest = {
    sourcePath: IDENTITY_DATABASE_PATH,
    mode: sourceStats.mode & 0o777,
    uid: sourceStats.uid,
    gid: sourceStats.gid,
    size: snapshot.byteLength,
    sha256: sha256(snapshot),
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600, flag: "wx" }
  );
  fsyncPath(backupPath);
  fsyncPath(manifestPath);
  fsyncPath(root);

  const persisted: Buffer = readFileSync(backupPath);
  if (
    persisted.byteLength !== snapshot.byteLength ||
    sha256(persisted) !== manifest.sha256
  ) {
    throw new Error(`${backupPath}: external migration backup hash verification failed.`);
  }
  const backup: IdentityDatabase = openIdentityDatabase({
    path: backupPath,
    readonly: true,
  });
  try {
    assertIdentityDatabaseIntegrity(backup);
    assertIdentityDatabaseJsonbStorage(backup, backupPath);
  } finally {
    closeIdentityDatabase(backup);
  }
  return root;
}

async function main(): Promise<void> {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--apply"
  ) {
    throw new Error(
      "Usage: bun run migrate:whitelist-permission -- --apply (stop the service first)."
    );
  }
  await acquireSingleInstanceLock(BOT_TOKEN);
  let backupRoot: string;
  try {
    const database: IdentityDatabase = openIdentityDatabase({
      path: IDENTITY_DATABASE_PATH,
      requireWritableAccess: true,
    });
    try {
      assertIdentityDatabaseIntegrity(database);
      assertIdentityDatabaseJsonbStorage(database, IDENTITY_DATABASE_PATH);
      const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
      const version: number = schemaVersion(rows);
      const journal: readonly IdentityDatabaseMigrationJournalEntry[] =
        readIdentityDatabaseMigrationJournal(database);
      if (version === IDENTITY_DATABASE_SCHEMA_VERSION) {
        validateCurrentDatabase(database);
        process.stdout.write("Identity database is already at whitelist permission schema v3.\n");
        return;
      }
      if (
        version !== PREVIOUS_SCHEMA_VERSION ||
        !isPreviousMigrationJournal(journal)
      ) {
        throw new Error(
          `${IDENTITY_DATABASE_PATH}: expected the exact deployed JSONB schema v${PREVIOUS_SCHEMA_VERSION} migration lineage before upgrading.`
        );
      }
      validatePreviousDatabaseRows(rows);
      backupRoot = createExternalBackup(database);
      migrateIdentityDatabaseSchema(database);
      validateCurrentDatabase(database);
    } finally {
      closeIdentityDatabase(database);
    }
    process.stdout.write(
      `Whitelist permission schema migration completed; external backup retained at ${backupRoot}.\n`
    );
  } finally {
    await releaseSingleInstanceLock(BOT_TOKEN);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown): never => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
