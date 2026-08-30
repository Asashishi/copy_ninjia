/** `storage.sqlite` v5 → v7 临时白名单与广告免检冷迁移入口。 */

import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOT_TOKEN } from "../packages/config/telegram";
import { IDENTITY_DATABASE_PATH } from "../packages/consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../packages/database/interact/connection";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage,
  assertStorageDatabaseSchemaV5MigrationLineage,
  assertStorageDatabaseSchemaV6MigrationLineage,
  assertStorageDatabaseStartupJsonbStorage,
  assertStoredIdentityPolicies,
  readStorageDatabaseSchemaMetadata,
} from "../packages/database/interact/inspection";
import { migrateStorageDatabaseSchema } from
  "../packages/database/interact/migration";
import { readStorageSchemaVersion } from
  "../packages/database/validation/storageRows";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from
  "../packages/infra/storage/instanceLock";
import type {
  StorageDatabase,
  StoredStorageMetadataRow,
} from "../packages/types/storageDatabase";
import {
  manifestEntry,
  writeVerifiedBackup,
  writeVerifiedBackupManifest,
} from "./migration/backup";
import type { BackupManifestEntry } from "./migration/backup";
import {
  retainedBackupError,
  runLockedMigration,
  runWithRetainedBackup,
} from "./migration/lifecycle";

type MigrationLockOperation = (botToken: string) => Promise<void>;

export interface TemporaryWhitelistMigrationDependencies {
  readonly acquireLock: MigrationLockOperation;
  readonly releaseLock: MigrationLockOperation;
  readonly createBackup: (databasePath: string) => Promise<string>;
  readonly migrateSchema: (database: StorageDatabase) => void;
}

const DEFAULT_DEPENDENCIES: Readonly<TemporaryWhitelistMigrationDependencies> = {
  acquireLock: acquireSingleInstanceLock,
  releaseLock: releaseSingleInstanceLock,
  createBackup: createExternalStorageDatabaseBackup,
  migrateSchema: migrateStorageDatabaseSchema,
};

/** 在工作树外逐文件备份主库及现存 WAL/SHM，并记录权限、属主与 SHA-256。 */
export async function createExternalStorageDatabaseBackup(
  databasePath: string
): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-temp-white-"));
  try {
    const manifest: BackupManifestEntry[] = [];
    const paths: readonly string[] = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const stats: ReturnType<typeof lstatSync> = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${path}: expected a regular non-symbolic-link database file.`);
      }
      const bytes: Uint8Array = await Bun.file(path).bytes();
      const backupFile: string = basename(path);
      writeVerifiedBackup(root, backupFile, bytes);
      manifest.push(manifestEntry(path, backupFile, bytes));
    }
    if (manifest.length === 0 || manifest[0]?.sourcePath !== databasePath) {
      throw new Error(`${databasePath}: database file is missing.`);
    }
    writeVerifiedBackupManifest(root, manifest);
    return root;
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(
      `External migration backup retained at ${root}; verification failed: ${reason}`,
      { cause: error }
    );
  }
}

function inspectSupportedSchema(
  database: StorageDatabase,
  source: string
): 5 | 6 | 7 {
  assertStorageDatabaseStartupJsonbStorage(database, source);
  const metadata: readonly StoredStorageMetadataRow[] =
    readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion({ metadata }, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  if (version === 5) {
    assertStorageDatabaseSchemaV5MigrationLineage(database, source);
    return 5;
  }
  if (version === 6) {
    assertStorageDatabaseSchemaV6MigrationLineage(database, source);
    return 6;
  }
  if (version === 7) {
    assertStorageDatabaseMigrationLineage(database, source);
    assertStoredIdentityPolicies(database, source);
    return 7;
  }
  throw new Error(
    `${source}: storage_metadata schema-version must be {"version":5}, {"version":6}, or {"version":7}.`
  );
}

function inspectDatabasePath(
  databasePath: string,
  requireWritableAccess: boolean
): 5 | 6 | 7 {
  if (!existsSync(databasePath)) {
    throw new Error(`${databasePath}: database file is missing.`);
  }
  const stats: ReturnType<typeof lstatSync> = lstatSync(databasePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `${databasePath}: expected a regular non-symbolic-link database file.`
    );
  }
  const database: StorageDatabase = openStorageDatabase({
    path: databasePath,
    readonly: true,
    requireWritableAccess,
  });
  try {
    return inspectSupportedSchema(database, databasePath);
  } finally {
    closeStorageDatabase(database);
  }
}

export interface RunTemporaryWhitelistMigrationOptions {
  readonly mode: "check" | "apply";
  readonly botToken?: string;
  readonly databasePath?: string;
  readonly dependencies?: Readonly<Partial<TemporaryWhitelistMigrationDependencies>>;
}

/** 在单实例锁内预检或应用最近已发布 v5 → 当前 v7 的唯一直接迁移。 */
export function runTemporaryWhitelistMigration({
  mode,
  botToken = BOT_TOKEN,
  databasePath = IDENTITY_DATABASE_PATH,
  dependencies: overrides = {},
}: RunTemporaryWhitelistMigrationOptions): Promise<string> {
  const dependencies: TemporaryWhitelistMigrationDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let retainedBackupRoot: string | null = null;
  return runLockedMigration({
    acquire: (): Promise<void> => dependencies.acquireLock(botToken),
    release: async (): Promise<void> => {
      try {
        await dependencies.releaseLock(botToken);
      } catch (error: unknown) {
        if (retainedBackupRoot === null) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        throw retainedBackupError({
          backupRoot: retainedBackupRoot,
          phase: "lock release failed",
          error,
        });
      }
    },
    run: async (): Promise<string> => {
      const version: 5 | 6 | 7 = inspectDatabasePath(
        databasePath,
        mode === "apply"
      );
      if (version === 7) {
        return "Temporary-whitelist SQLite cold migration is already complete.\n";
      }
      if (mode === "check") {
        return "Temporary-whitelist SQLite cold migration check passed; " +
          `schema v${version} is ready for direct migration. No deployment data was changed.\n`;
      }

      retainedBackupRoot = await dependencies.createBackup(databasePath);
      await runWithRetainedBackup({
        backupRoot: retainedBackupRoot,
        run: (): void => {
          const database: StorageDatabase = openStorageDatabase({
            path: databasePath,
            requireWritableAccess: true,
          });
          try {
            if (inspectSupportedSchema(database, databasePath) !== version) {
              throw new Error(`${databasePath}: schema changed after migration preflight.`);
            }
            dependencies.migrateSchema(database);
            if (inspectSupportedSchema(database, databasePath) !== 7) {
              throw new Error(`${databasePath}: migration did not produce schema v7.`);
            }
          } finally {
            closeStorageDatabase(database);
          }
        },
      });
      return "Temporary-whitelist SQLite cold migration completed; " +
        `external backup retained at ${retainedBackupRoot}.\n`;
    },
  });
}

if (import.meta.main) {
  const args: string[] = Bun.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--apply")) {
    console.error(
      "Usage: bun run migrate:temporary-whitelist -- --check|--apply (stop the service first)."
    );
    process.exit(1);
  }
  await runTemporaryWhitelistMigration({
    mode: args[0] === "--apply" ? "apply" : "check",
  }).then((message: string): Promise<number> => Bun.write(Bun.stdout, message))
    .catch((error: unknown): never => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
