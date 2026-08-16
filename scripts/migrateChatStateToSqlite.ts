/**
 * state.json chats -> database/storage.sqlite:chat_states 冷迁移入口。
 *
 * `--check` 与 `--apply` 都取得 bot.lock，确保只在服务停止后读取一致来源。
 * 写入前在工作树外保留 state 主备与 SQLite 一致快照及权限/属主/哈希清单。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BOT_TOKEN } from "../packages/config/telegram";
import {
  IDENTITY_DATABASE_PATH,
  STATE_BACKUP_FILE_PATH,
  STATE_FILE_PATH,
} from "../packages/consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
  serializeStorageDatabaseSnapshot,
} from "../packages/database/interact/connection";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from
  "../packages/infra/storage/instanceLock";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { assertStorageDatabaseIntegrity } from "./storageDatabaseIntegrity";
import type { StorageDatabase } from "../packages/types/storageDatabase";
import {
  applyChatStateDatabaseMigration,
  assertChatStateMigrationReady,
  inspectChatStateDatabase,
  loadChatStateMigrationDraft,
  loadChatStateMigrationSource,
  resolveChatStateMigrationDraft,
} from "./chatStateMigration/core";
import type {
  ChatStateMigrationDraft,
  ChatStateMigrationSource,
  ChatStateMigrationStatus,
} from "./chatStateMigration/core";
import { queryPreviousBotPermissions } from
  "./chatStateMigration/telegram";
import type { BotChatPermissions } from "../packages/types/telegram";

interface BackupManifestEntry {
  readonly sourcePath: string;
  readonly backupFile: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
}

interface ExternalBackup {
  readonly root: string;
  readonly entries: readonly BackupManifestEntry[];
}

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

function assertRegularFile(path: string): void {
  const stats: ReturnType<typeof lstatSync> = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${path}: cold migration sources must be regular files, not symbolic links.`);
  }
}

function writeVerifiedBackup(
  root: string,
  backupFile: string,
  bytes: Uint8Array
): void {
  const path: string = join(root, backupFile);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  fsyncPath(path);
  const persisted: Buffer = readFileSync(path);
  if (persisted.byteLength !== bytes.byteLength || sha256(persisted) !== sha256(bytes)) {
    throw new Error(`${path}: external migration backup hash verification failed.`);
  }
}

function manifestEntry(
  sourcePath: string,
  backupFile: string,
  bytes: Uint8Array
): BackupManifestEntry {
  const stats: ReturnType<typeof statSync> = statSync(sourcePath);
  return {
    sourcePath,
    backupFile,
    mode: stats.mode & 0o777,
    uid: stats.uid,
    gid: stats.gid,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function createExternalBackup(database: StorageDatabase): ExternalBackup {
  for (const path of [STATE_FILE_PATH, STATE_BACKUP_FILE_PATH, IDENTITY_DATABASE_PATH]) {
    assertRegularFile(path);
  }
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-chat-state-migration-"));
  try {
    const stateBytes: Buffer = readFileSync(STATE_FILE_PATH);
    const stateBackupBytes: Buffer = readFileSync(STATE_BACKUP_FILE_PATH);
    const databaseBytes: Uint8Array = serializeStorageDatabaseSnapshot(database);
    const sources: readonly Readonly<{
      sourcePath: string;
      backupFile: string;
      bytes: Uint8Array;
    }>[] = [
      { sourcePath: STATE_FILE_PATH, backupFile: basename(STATE_FILE_PATH), bytes: stateBytes },
      {
        sourcePath: STATE_BACKUP_FILE_PATH,
        backupFile: basename(STATE_BACKUP_FILE_PATH),
        bytes: stateBackupBytes,
      },
      {
        sourcePath: IDENTITY_DATABASE_PATH,
        backupFile: basename(IDENTITY_DATABASE_PATH),
        bytes: databaseBytes,
      },
    ];
    const manifest: BackupManifestEntry[] = [];
    for (const source of sources) {
      writeVerifiedBackup(root, source.backupFile, source.bytes);
      manifest.push(manifestEntry(source.sourcePath, source.backupFile, source.bytes));
    }
    const manifestPath: string = join(root, "manifest.json");
    const manifestText: string = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestText, { flag: "wx", mode: 0o600 });
    fsyncPath(manifestPath);
    fsyncPath(root);

    const snapshotPath: string = join(root, basename(IDENTITY_DATABASE_PATH));
    const snapshot: StorageDatabase = openStorageDatabase({
      path: snapshotPath,
      readonly: true,
    });
    try {
      inspectChatStateDatabase(snapshot, snapshotPath);
    } finally {
      closeStorageDatabase(snapshot);
    }
    return { root, entries: manifest };
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External migration backup retained at ${root}; verification failed: ${reason}`,
      { cause: error }
    );
  }
}

function sameSource(
  left: ChatStateMigrationSource,
  right: ChatStateMigrationSource
): boolean {
  return left.normalizationTime === right.normalizationTime &&
    left.globalText === right.globalText &&
    left.mainKind === right.mainKind &&
    left.backupKind === right.backupKind &&
    JSON.stringify(left.chatRows) === JSON.stringify(right.chatRows);
}

function syncDatabaseFiles(): void {
  for (const path of [IDENTITY_DATABASE_PATH, `${IDENTITY_DATABASE_PATH}-wal`]) {
    if (existsSync(path)) fsyncPath(path);
  }
  fsyncPath(dirname(IDENTITY_DATABASE_PATH));
}

function backupEntryFor(
  backup: ExternalBackup,
  sourcePath: string
): BackupManifestEntry {
  const entry: BackupManifestEntry | undefined = backup.entries.find(
    (candidate: BackupManifestEntry): boolean => candidate.sourcePath === sourcePath
  );
  if (entry === undefined) {
    throw new Error(`${sourcePath}: external backup manifest entry is missing.`);
  }
  return entry;
}

function assertSourceMetadata(entry: BackupManifestEntry): void {
  const stats: ReturnType<typeof statSync> = statSync(entry.sourcePath);
  if (
    (stats.mode & 0o777) !== entry.mode ||
    stats.uid !== entry.uid ||
    stats.gid !== entry.gid
  ) {
    throw new Error(`${entry.sourcePath}: owner or mode changed during cold migration.`);
  }
}

async function publishStateFile(
  entry: BackupManifestEntry,
  content: string
): Promise<void> {
  await atomicWriteText(entry.sourcePath, content, entry.mode);
  const published: ReturnType<typeof statSync> = statSync(entry.sourcePath);
  if (published.uid !== entry.uid || published.gid !== entry.gid) {
    chownSync(entry.sourcePath, entry.uid, entry.gid);
  }
  if ((published.mode & 0o777) !== entry.mode) chmodSync(entry.sourcePath, entry.mode);
  fsyncPath(entry.sourcePath);
  assertSourceMetadata(entry);
}

async function applyMigration(
  database: StorageDatabase,
  source: ChatStateMigrationSource,
  permissions: ReadonlyMap<number, Readonly<BotChatPermissions>>
): Promise<string> {
  const backup: ExternalBackup = createExternalBackup(database);
  try {
    const stableDraft: ChatStateMigrationDraft = loadChatStateMigrationDraft({
      statePath: STATE_FILE_PATH,
      backupPath: STATE_BACKUP_FILE_PATH,
      normalizationTime: source.normalizationTime,
    });
    const stableSource: ChatStateMigrationSource =
      resolveChatStateMigrationDraft(stableDraft, permissions);
    if (!sameSource(source, stableSource)) {
      throw new Error("State sources changed during cold migration validation.");
    }

    applyChatStateDatabaseMigration(database, source, IDENTITY_DATABASE_PATH);
    database.$client.run("PRAGMA wal_checkpoint(FULL);");
    syncDatabaseFiles();

    // LKG 先切换；任一步中断都会留下 core 能严格识别并继续的一新一旧状态。
    await publishStateFile(
      backupEntryFor(backup, STATE_BACKUP_FILE_PATH),
      source.globalText
    );
    await publishStateFile(backupEntryFor(backup, STATE_FILE_PATH), source.globalText);
    const verified: ChatStateMigrationSource = loadChatStateMigrationSource({
      statePath: STATE_FILE_PATH,
      backupPath: STATE_BACKUP_FILE_PATH,
      normalizationTime: source.normalizationTime,
    });
    if (
      verified.mainKind !== "current" ||
      verified.backupKind !== "current" ||
      verified.globalText !== source.globalText
    ) {
      throw new Error("Global-only state verification failed.");
    }
    const status: ChatStateMigrationStatus = assertChatStateMigrationReady(
      database,
      verified,
      IDENTITY_DATABASE_PATH
    );
    if (status !== "alreadyMigrated") {
      throw new Error("Cold migration did not reach its final state.");
    }
    for (const entry of backup.entries) assertSourceMetadata(entry);
    return backup.root;
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External backup retained at ${backup.root}; cold migration stopped: ${reason}`,
      { cause: error }
    );
  }
}

/** 成功结束前的第二次整库检查；迁移已写入时保留外部备份路径诊断。 */
function assertFinalDatabaseIntegrity(
  database: StorageDatabase,
  backupRoot: string | null
): void {
  try {
    assertStorageDatabaseIntegrity(database);
  } catch (error: unknown) {
    if (backupRoot === null) throw error;
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External backup retained at ${backupRoot}; final integrity check failed: ${reason}`,
      { cause: error }
    );
  }
}

async function run(): Promise<void> {
  const args: string[] = Bun.argv.slice(2);
  if (
    args.length !== 1 ||
    (args[0] !== "--check" && args[0] !== "--apply")
  ) {
    throw new Error("Usage: bun run migrate:chat-state -- --check|--apply (stop the service first).");
  }
  await acquireSingleInstanceLock(BOT_TOKEN);
  try {
    const database: StorageDatabase = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
      readonly: args[0] === "--check",
      requireWritableAccess: args[0] === "--apply",
    });
    try {
      assertStorageDatabaseIntegrity(database);
      const draft: ChatStateMigrationDraft = loadChatStateMigrationDraft({
        statePath: STATE_FILE_PATH,
        backupPath: STATE_BACKUP_FILE_PATH,
      });
      const permissions: ReadonlyMap<number, Readonly<BotChatPermissions>> =
        await queryPreviousBotPermissions(draft.permissionChatIds);
      const source: ChatStateMigrationSource =
        resolveChatStateMigrationDraft(draft, permissions);
      const status: ChatStateMigrationStatus = assertChatStateMigrationReady(
        database,
        source,
        IDENTITY_DATABASE_PATH
      );
      let backupRoot: string | null = null;
      let completionMessage: string;
      if (status === "alreadyMigrated") {
        completionMessage = "Chat-state cold migration is already complete.\n";
      } else if (args[0] === "--check") {
        completionMessage =
          `Chat-state cold migration check passed for ${source.chatRows?.length ?? 0} chat row(s); no deployment data was changed.\n`;
      } else {
        backupRoot = await applyMigration(
          database,
          source,
          permissions
        );
        completionMessage =
          `Chat-state cold migration completed for ${source.chatRows?.length ?? 0} row(s); ` +
          `external backup retained at ${backupRoot}.\n`;
      }
      assertFinalDatabaseIntegrity(database, backupRoot);
      process.stdout.write(completionMessage);
    } finally {
      closeStorageDatabase(database);
    }
  } finally {
    await releaseSingleInstanceLock(BOT_TOKEN);
  }
}

if (import.meta.main) {
  await run().catch((error: unknown): never => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
