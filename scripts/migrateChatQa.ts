/**
 * SQLite schema v4 -> v5（群问答入库）冷迁移入口。
 *
 * `--check` 与 `--apply` 都取得 `bot.lock`，确保只在服务停止后读取一致来源。
 * 写入前在工作树外保留 SQLite 一致快照及权限/属主/SHA-256 清单。
 *
 * 与上一条冷迁移的关键差别：本次**不搬运任何业务数据**。v5 只多一张空的
 * `chat_qa` 表，外加给每条白名单补上 `isCanControllQaPermission`（存量条目
 * 全项为真时才给真，见 0003 migration）。因此这里没有来源文件解析，核验的
 * 重点是「业务行一行没多、一行没少，且新 schema 下整库仍可严格解码」。
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOT_TOKEN } from "../packages/config/telegram";
import { IDENTITY_DATABASE_PATH } from "../packages/consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
  serializeStorageDatabaseSnapshot,
} from "../packages/database/interact/connection";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from
  "../packages/infra/storage/instanceLock";
import { assertStorageDatabaseIntegrity } from "./storageDatabaseIntegrity";
import {
  applyChatQaMigration,
  assertChatQaMigrationResult,
  CURRENT_SCHEMA_VERSION,
  inspectChatQaDatabase,
} from "./chatQaMigration/database";
import type { ChatQaDatabaseInspection } from "./chatQaMigration/database";
import type {
  StorageDatabase,
  StorageDatabaseBaseRows,
} from "../packages/types/storageDatabase";

interface BackupManifestEntry {
  readonly sourcePath: string;
  readonly backupFile: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly sha256: string;
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

/** 写入备份后立刻读回比对哈希；写成功不等于落地内容正确。 */
function writeVerifiedBackup(root: string, backupFile: string, bytes: Uint8Array): void {
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

/**
 * 在工作树外留下带清单的一致快照，并当场把它当成一个真库重新检查一遍。
 *
 * 备份没被验证过就等于没有备份：能恢复的前提是它自己也能通过谱系与整库校验。
 */
function createExternalBackup(database: StorageDatabase): string {
  assertRegularFile(IDENTITY_DATABASE_PATH);
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-chat-qa-migration-"));
  try {
    const databaseBytes: Uint8Array = serializeStorageDatabaseSnapshot(database);
    const backupFile: string = basename(IDENTITY_DATABASE_PATH);
    writeVerifiedBackup(root, backupFile, databaseBytes);
    const manifest: readonly BackupManifestEntry[] = [
      manifestEntry(IDENTITY_DATABASE_PATH, backupFile, databaseBytes),
    ];
    const manifestPath: string = join(root, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fsyncPath(manifestPath);
    fsyncPath(root);

    const snapshot: StorageDatabase = openStorageDatabase({
      path: join(root, backupFile),
      readonly: true,
    });
    try {
      assertStorageDatabaseIntegrity(snapshot);
      inspectChatQaDatabase(snapshot, join(root, backupFile));
    } finally {
      closeStorageDatabase(snapshot);
    }
    return root;
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External migration backup retained at ${root}; verification failed: ${reason}`,
      { cause: error }
    );
  }
}

/** 最终整库校验；备份路径已存在时把它写进错误，别让运维找不到现场。 */
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
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--apply")) {
    throw new Error("Usage: bun run migrate:chat-qa -- --check|--apply (stop the service first).");
  }
  const isApply: boolean = args[0] === "--apply";
  await acquireSingleInstanceLock(BOT_TOKEN);
  try {
    const database: StorageDatabase = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
      readonly: !isApply,
      requireWritableAccess: isApply,
    });
    try {
      assertStorageDatabaseIntegrity(database);
      const inspection: ChatQaDatabaseInspection = inspectChatQaDatabase(
        database,
        IDENTITY_DATABASE_PATH
      );
      let backupRoot: string | null = null;
      let completionMessage: string;
      if (inspection.version === CURRENT_SCHEMA_VERSION) {
        completionMessage = "Chat-qa cold migration is already complete.\n";
      } else if (!isApply) {
        completionMessage =
          "Chat-qa cold migration check passed; no deployment data was changed.\n";
      } else {
        const before: StorageDatabaseBaseRows = inspection.baseRows;
        backupRoot = createExternalBackup(database);
        applyChatQaMigration(database);
        assertChatQaMigrationResult(database, IDENTITY_DATABASE_PATH, before);
        completionMessage =
          `Chat-qa cold migration completed; external backup retained at ${backupRoot}.\n`;
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
