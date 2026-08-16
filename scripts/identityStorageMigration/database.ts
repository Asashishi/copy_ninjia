import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../../packages/consts/identityStorage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
  RUNTIME_DATA_ROOT,
} from "../../packages/consts/paths";
import {
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import { seedStorageDatabase } from "../../packages/database/interact/admin";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import {
  assertStorageDatabaseJsonbStorage,
  readStorageDatabaseRows,
} from "../../packages/database/interact/inspection";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { syncDirectorySync } from "../../packages/libs/atomicFile";
import { assertStorageDatabaseIntegrity } from "../storageDatabaseIntegrity";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
  WhitelistEntryData,
} from "../../packages/types/identityPolicy";
import type { MigrationInput } from "../../packages/types/identityStorageMigration";
import type {
  StorageDatabase,
  StorageDatabaseRows,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../../packages/types/storageDatabase";
import {
  fsyncMigrationDirectoryTree,
  fsyncMigrationPath,
} from "./filesystem";

/** 把严格解析与 Telegram 补全后的身份行种入一个空数据库事务。 */
export interface InsertMigratedRowsParams {
  readonly database: StorageDatabase;
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly blockedAt: string;
}

export function insertMigratedRows({
  database,
  input,
  metadata,
  blockedAt,
}: InsertMigratedRowsParams): void {
  const whitelist: StoredIdentityPolicyRow[] = [];
  for (const [id, permissions] of input.whitelist) {
    const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
    if (meta === undefined) {
      throw new Error(`Missing queried metadata for whitelist identity ${id}.`);
    }
    const data: WhitelistEntryData = { permissions, meta };
    whitelist.push({ id, data: encodeWhitelistEntryData(data) });
  }
  const blocklist: StoredIdentityPolicyRow[] = [];
  for (const id of input.blockedIds) {
    const meta: Readonly<TelegramIdentityMetadata> | undefined = metadata.get(id);
    if (meta === undefined) {
      throw new Error(`Missing queried metadata for blocklist identity ${id}.`);
    }
    const data: BlocklistEntryData = { blockedAt, meta };
    blocklist.push({ id, data: encodeBlocklistEntryData(data) });
  }
  const removals: StoredPendingRemovalRow[] = [];
  for (const [removalId, pending] of input.removals) {
    removals.push({
      removalId,
      data: encodePendingBlockedRemovalData(pending).text,
    });
  }
  seedStorageDatabase(database, {
    metadata: [{
      key: IDENTITY_DATABASE_SCHEMA_KEY,
      data: IDENTITY_DATABASE_SCHEMA_DATA,
    }],
    whitelist,
    blocklist,
    removals,
  });
}

/** 迁移后逐行复验所需的源数据。 */
export interface VerifyDatabaseParams {
  readonly path: string;
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly blockedAt: string;
}

export function verifyDatabase({
  path,
  input,
  metadata,
  blockedAt,
}: VerifyDatabaseParams): void {
  const database: StorageDatabase = openStorageDatabase({ path, readonly: true });
  try {
    assertStorageDatabaseJsonbStorage(database, path);
    const rows: StorageDatabaseRows = readStorageDatabaseRows(database);
    const whiteRows: readonly StoredIdentityPolicyRow[] = rows.whitelist;
    const blackRows: readonly StoredIdentityPolicyRow[] = rows.blocklist;
    const removalRows: readonly StoredPendingRemovalRow[] = rows.removals;
    const metadataRows: StorageDatabaseRows["metadata"] = rows.metadata;
    if (
      whiteRows.length !== input.whitelist.size ||
      blackRows.length !== input.blockedIds.length ||
      removalRows.length !== input.removals.size ||
      metadataRows.length !== 1 ||
      metadataRows[0]?.key !== IDENTITY_DATABASE_SCHEMA_KEY ||
      metadataRows[0]?.data !== IDENTITY_DATABASE_SCHEMA_DATA
    ) {
      throw new Error(
        `${path}: migrated row counts do not match the strictly parsed source structures.`
      );
    }

    const expectedWhitelist: Map<number, string> = new Map();
    for (const [id, permissions] of input.whitelist) {
      const meta: Readonly<TelegramIdentityMetadata> | undefined =
        metadata.get(id);
      if (meta === undefined) {
        throw new Error(`${path}: missing expected whitelist metadata for ${id}.`);
      }
      expectedWhitelist.set(id, encodeWhitelistEntryData({ permissions, meta }));
    }
    const expectedBlocklist: Map<number, string> = new Map();
    for (const id of input.blockedIds) {
      const meta: Readonly<TelegramIdentityMetadata> | undefined =
        metadata.get(id);
      if (meta === undefined) {
        throw new Error(`${path}: missing expected blocklist metadata for ${id}.`);
      }
      expectedBlocklist.set(
        id,
        encodeBlocklistEntryData({ blockedAt, meta })
      );
    }
    for (const row of whiteRows) {
      decodeWhitelistEntryData(
        row.data,
        `${path}:whitelist_entries[${row.id}]`
      );
      if (expectedWhitelist.get(row.id) !== row.data) {
        throw new Error(
          `${path}: whitelist row ${row.id} does not match its migrated source value.`
        );
      }
      expectedWhitelist.delete(row.id);
    }
    for (const row of blackRows) {
      decodeBlocklistEntryData(
        row.data,
        `${path}:blocklist_entries[${row.id}]`
      );
      if (expectedBlocklist.get(row.id) !== row.data) {
        throw new Error(
          `${path}: blocklist row ${row.id} does not match its migrated source value.`
        );
      }
      expectedBlocklist.delete(row.id);
    }
    if (expectedWhitelist.size !== 0 || expectedBlocklist.size !== 0) {
      throw new Error(
        `${path}: migrated identity primary keys do not match the source structures.`
      );
    }

    const expectedRemovals: Map<number, string> = new Map();
    for (const [removalId, pending] of input.removals) {
      expectedRemovals.set(
        removalId,
        encodePendingBlockedRemovalData(pending).text
      );
    }
    for (const row of removalRows) {
      const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
        row.data,
        `${path}:pending_blocked_removals[${row.removalId}]`
      );
      if (pending.params.removalId !== row.removalId) {
        throw new Error(`${path}: pending removal primary key mismatch.`);
      }
      if (expectedRemovals.get(row.removalId) !== row.data) {
        throw new Error(
          `${path}: pending removal row ${row.removalId} does not match its migrated source value.`
        );
      }
      expectedRemovals.delete(row.removalId);
    }
    if (expectedRemovals.size !== 0) {
      throw new Error(
        `${path}: migrated pending removal primary keys do not match the source structure.`
      );
    }
  } finally {
    closeStorageDatabase(database);
  }
}

/** 冷迁移编排边界专用；普通逐行业务复验不得隐式重复整库检查。 */
function assertDatabaseIntegrityAtPath(path: string): void {
  const database: StorageDatabase = openStorageDatabase({ path, readonly: true });
  try {
    assertStorageDatabaseIntegrity(database);
  } finally {
    closeStorageDatabase(database);
  }
}

/** 原子发布数据库所需的完整迁移输入。 */
export interface CreateMigratedDatabaseOptions {
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
  readonly blockedAt: string;
}

/** 创建、逐行复验、原子发布并启用 WAL；失败时清除未完成目标。 */
export function createMigratedDatabase({
  input,
  metadata,
  blockedAt,
}: CreateMigratedDatabaseOptions): void {
  if (existsSync(IDENTITY_DATABASE_PATH)) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: target already exists; refusing to overwrite it.`
    );
  }
  mkdirSync(DATABASE_DIR, {
    recursive: true,
    mode: IDENTITY_DATABASE_DIRECTORY_MODE,
  });
  const directoryStats: ReturnType<typeof statSync> = statSync(DATABASE_DIR);
  const dataRootStats: ReturnType<typeof statSync> = statSync(RUNTIME_DATA_ROOT);
  if (directoryStats.gid !== dataRootStats.gid) {
    chownSync(DATABASE_DIR, directoryStats.uid, dataRootStats.gid);
  }
  chmodSync(DATABASE_DIR, IDENTITY_DATABASE_DIRECTORY_MODE);
  const tempPath: string = join(
    DATABASE_DIR,
    `.storage.sqlite.${crypto.randomUUID()}.tmp`
  );
  let targetCreated: boolean = false;
  let completed: boolean = false;
  try {
    createStorageDatabase(tempPath);
    assertDatabaseIntegrityAtPath(tempPath);
    const tempStats: ReturnType<typeof statSync> = statSync(tempPath);
    const databaseDirectoryGroup: number = statSync(DATABASE_DIR).gid;
    if (tempStats.gid !== databaseDirectoryGroup) {
      chownSync(tempPath, tempStats.uid, databaseDirectoryGroup);
    }
    const database: StorageDatabase = openStorageDatabase({ path: tempPath });
    try {
      insertMigratedRows({ database, input, metadata, blockedAt });
    } finally {
      closeStorageDatabase(database);
    }
    chmodSync(tempPath, IDENTITY_DATABASE_FILE_MODE);
    verifyDatabase({ path: tempPath, input, metadata, blockedAt });
    fsyncMigrationPath(tempPath);
    renameSync(tempPath, IDENTITY_DATABASE_PATH);
    targetCreated = true;
    syncDirectorySync(IDENTITY_DATABASE_PATH);
    enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
    chmodSync(IDENTITY_DATABASE_PATH, IDENTITY_DATABASE_FILE_MODE);
    fsyncMigrationPath(IDENTITY_DATABASE_PATH);
    verifyDatabase({
      path: IDENTITY_DATABASE_PATH,
      input,
      metadata,
      blockedAt,
    });
    assertDatabaseIntegrityAtPath(IDENTITY_DATABASE_PATH);
    fsyncMigrationDirectoryTree(DATABASE_DIR);
    completed = true;
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (!completed && targetCreated) {
      for (const path of [
        IDENTITY_DATABASE_PATH,
        `${IDENTITY_DATABASE_PATH}-wal`,
        `${IDENTITY_DATABASE_PATH}-shm`,
      ]) {
        if (existsSync(path)) unlinkSync(path);
      }
      fsyncMigrationPath(DATABASE_DIR);
    }
  }
}
