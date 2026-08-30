import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT } from
  "../../packages/consts/identityStorage";
import { initializeStorageDatabase } from
  "../../packages/database/interact/initialization";
import {
  assertStorageDatabaseMigrationLineage,
  assertStoredIdentityPolicies,
} from "../../packages/database/interact/inspection";
import { createStorageDatabase, migrateStorageDatabaseSchema } from
  "../../packages/database/interact/migration";
import type { StorageDatabase } from
  "../../packages/types/storageDatabase";
import {
  createExternalStorageDatabaseBackup,
  runTemporaryWhitelistMigration,
} from "../../scripts/migrateTemporaryWhitelist";
import type { TemporaryWhitelistMigrationDependencies } from
  "../../scripts/migrateTemporaryWhitelist";
import type { BackupManifestEntry } from
  "../../scripts/migration/backup";

const roots: string[] = [];

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
}

function temporaryRoot(prefix: string): string {
  const root: string = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createSchemaV5Database(): string {
  const root: string = temporaryRoot("copy-ninjia-temp-white-migration-test-");
  const path: string = join(root, "storage.sqlite");
  createStorageDatabase(path);
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    initializeStorageDatabase(database);
    const migrations: { readonly createdAt: number }[] = database.$client
      .query<{ readonly createdAt: number }, []>(
        "SELECT created_at AS createdAt FROM __drizzle_migrations " +
        "ORDER BY created_at DESC LIMIT 2;"
      ).all().reverse();
    if (migrations.length !== 2) throw new Error("latest migrations must exist");
    database.$client.run("DROP TABLE temporary_whitelist_entries;");
    database.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at >= ?1;",
      [migrations[0]!.createdAt]
    );
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
      ['{"version":5}']
    );
  } finally {
    closeStorageDatabase(database);
  }
  return path;
}

function createSchemaV6Database(): string {
  const root: string = temporaryRoot("copy-ninjia-temp-white-v6-migration-test-");
  const path: string = join(root, "storage.sqlite");
  createStorageDatabase(path);
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    initializeStorageDatabase(database);
    const previousCreateTable: string | undefined = readFileSync(
      join(
        import.meta.dir,
        "../../packages/database/schema/migrations/0004_temporary_whitelist.sql"
      ),
      "utf8"
    ).split("--> statement-breakpoint")[0]?.trim();
    if (previousCreateTable === undefined || previousCreateTable.length === 0) {
      throw new Error("v6 temporary whitelist DDL must exist");
    }
    database.$client.run("DROP TABLE temporary_whitelist_entries;");
    database.$client.run(previousCreateTable);
    database.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at = ?1;",
      [IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT]
    );
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
      ['{"version":6}']
    );
  } finally {
    closeStorageDatabase(database);
  }
  return path;
}

afterEach((): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("临时白名单 SQLite 冷迁移", () => {
  test("check 只验证 v5，apply 备份后直迁 v7 并可重复检查", async () => {
    const path: string = createSchemaV5Database();
    const acquireLock = mock(async (): Promise<void> => {});
    const releaseLock = mock(async (): Promise<void> => {});
    let backupRoot: string | null = null;
    const createBackup = async (databasePath: string): Promise<string> => {
      backupRoot = await createExternalStorageDatabaseBackup(databasePath);
      roots.push(backupRoot);
      return backupRoot;
    };

    await expect(runTemporaryWhitelistMigration({
      mode: "check",
      botToken: "test-token",
      databasePath: path,
      dependencies: { acquireLock, releaseLock, createBackup },
    })).resolves.toContain("schema v5 is ready");
    expect(backupRoot).toBeNull();

    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: path,
      dependencies: { acquireLock, releaseLock, createBackup },
    })).resolves.toContain("cold migration completed");
    expect(backupRoot).not.toBeNull();

    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      const version: { readonly version: number } | null = database.$client
        .query<{ readonly version: number }, []>(
          "SELECT json_extract(data, '$.version') AS version " +
          "FROM storage_metadata WHERE key = 'schema-version';"
        ).get();
      expect(version?.version).toBe(7);
      expect(database.$client.query<{ readonly count: number }, []>(
        "SELECT COUNT(*) AS count FROM temporary_whitelist_entries;"
      ).get()?.count).toBe(0);
      assertStorageDatabaseMigrationLineage(database, path);
      assertStoredIdentityPolicies(database, path);
    } finally {
      closeStorageDatabase(database);
    }

    await expect(runTemporaryWhitelistMigration({
      mode: "check",
      botToken: "test-token",
      databasePath: path,
      dependencies: { acquireLock, releaseLock, createBackup },
    })).resolves.toContain("already complete");
  });

  test("v6 首个合格日累计迁移为立即生效的临时广告免检", async () => {
    const path: string = createSchemaV6Database();
    const qualifiedAt: number = new Date("2026-08-29T12:00:00+09:00").getTime();
    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      database.$client.run(
        "INSERT INTO temporary_whitelist_entries " +
        "(id, temp_white, temp_white_at, temp_white_count, send_count, " +
        "counted_at, qualified_at) VALUES (?1, 0, NULL, 1, 8, ?2, ?2);",
        [7, qualifiedAt]
      );
    } finally {
      closeStorageDatabase(database);
    }

    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: path,
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => {},
        createBackup: async (): Promise<string> => {
          const root: string = temporaryRoot("copy-ninjia-v6-upgrade-backup-");
          return root;
        },
      },
    })).resolves.toContain("cold migration completed");

    const migrated: StorageDatabase = openStorageDatabase({ path });
    try {
      const row: {
        readonly tempWhite: number;
        readonly tempWhiteAt: number | null;
        readonly tempWhiteCount: number;
      } | null = migrated.$client.query<{
        readonly tempWhite: number;
        readonly tempWhiteAt: number | null;
        readonly tempWhiteCount: number;
      }, []>(
        "SELECT temp_white AS tempWhite, temp_white_at AS tempWhiteAt, " +
        "temp_white_count AS tempWhiteCount FROM temporary_whitelist_entries " +
        "WHERE id = 7;"
      ).get();
      expect(row).toEqual({
        tempWhite: 1,
        tempWhiteAt: qualifiedAt,
        tempWhiteCount: 1,
      });
      assertStorageDatabaseMigrationLineage(migrated, path);
      assertStoredIdentityPolicies(migrated, path);
    } finally {
      closeStorageDatabase(migrated);
    }
  });

  test("外部备份逐份保留主库、WAL、SHM 与恢复清单", async () => {
    const root: string = temporaryRoot("copy-ninjia-temp-white-backup-source-");
    const path: string = join(root, "storage.sqlite");
    writeFileSync(path, "database");
    writeFileSync(`${path}-wal`, "wal");
    writeFileSync(`${path}-shm`, "shm");

    const backupRoot: string = await createExternalStorageDatabaseBackup(path);
    roots.push(backupRoot);
    const manifest: readonly BackupManifestEntry[] = JSON.parse(
      readFileSync(join(backupRoot, "manifest.json"), "utf8")
    ) as readonly BackupManifestEntry[];

    expect(manifest.map((entry: BackupManifestEntry): string => entry.sourcePath))
      .toEqual([path, `${path}-wal`, `${path}-shm`]);
    expect(readFileSync(join(backupRoot, "storage.sqlite"), "utf8")).toBe("database");
    expect(readFileSync(join(backupRoot, "storage.sqlite-wal"), "utf8")).toBe("wal");
    expect(readFileSync(join(backupRoot, "storage.sqlite-shm"), "utf8")).toBe("shm");
  });

  test("备份后的迁移失败保留恢复路径且不伪报完成", async () => {
    const path: string = createSchemaV5Database();
    let backupRoot: string | null = null;
    const createBackup = async (databasePath: string): Promise<string> => {
      backupRoot = await createExternalStorageDatabaseBackup(databasePath);
      roots.push(backupRoot);
      return backupRoot;
    };

    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: path,
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => {},
        createBackup,
        migrateSchema: (): never => { throw new Error("injected migration failure"); },
      },
    })).rejects.toThrow(/External migration backup retained.*injected migration failure/);
    expect(backupRoot).not.toBeNull();
  });

  test("主库缺失、目录或 symlink 均在备份前拒绝", async () => {
    const root: string = temporaryRoot("copy-ninjia-temp-white-path-gate-");
    const missing: string = join(root, "missing.sqlite");
    const directory: string = join(root, "directory.sqlite");
    mkdirSync(directory);
    const target: string = createSchemaV5Database();
    const symlink: string = join(root, "linked.sqlite");
    symlinkSync(target, symlink);
    let backupCalls: number = 0;
    const dependencies: Readonly<Partial<TemporaryWhitelistMigrationDependencies>> = {
      acquireLock: async (): Promise<void> => {},
      releaseLock: async (): Promise<void> => {},
      createBackup: async (): Promise<string> => {
        backupCalls++;
        return temporaryRoot("copy-ninjia-unreachable-backup-");
      },
    };

    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: missing,
      dependencies,
    })).rejects.toThrow("database file is missing");
    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: directory,
      dependencies,
    })).rejects.toThrow("regular non-symbolic-link");
    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: symlink,
      dependencies,
    })).rejects.toThrow("regular non-symbolic-link");
    expect(backupCalls).toBe(0);
  });

  test("未知 schema 与伪造 v5 谱系保持原地并拒绝", async () => {
    const unknownPath: string = createSchemaV5Database();
    const unknown: StorageDatabase = openStorageDatabase({ path: unknownPath });
    try {
      unknown.$client.run(
        "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
        ['{"version":99}']
      );
    } finally {
      closeStorageDatabase(unknown);
    }
    const dependencies: Readonly<Partial<TemporaryWhitelistMigrationDependencies>> = {
      acquireLock: async (): Promise<void> => {},
      releaseLock: async (): Promise<void> => {},
    };
    await expect(runTemporaryWhitelistMigration({
      mode: "check",
      botToken: "test-token",
      databasePath: unknownPath,
      dependencies,
    })).rejects.toThrow('must be {"version":5}, {"version":6}, or {"version":7}');

    const forgedPath: string = createSchemaV5Database();
    const forged: StorageDatabase = openStorageDatabase({ path: forgedPath });
    try {
      forged.$client.run("DELETE FROM __drizzle_migrations;");
    } finally {
      closeStorageDatabase(forged);
    }
    await expect(runTemporaryWhitelistMigration({
      mode: "check",
      botToken: "test-token",
      databasePath: forgedPath,
      dependencies,
    })).rejects.toThrow();
  });

  test("备份后 schema 改变或 migrator 未产出 v7 都保留备份并失败", async () => {
    const changedPath: string = createSchemaV5Database();
    let changedBackupRoot: string | null = null;
    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: changedPath,
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => {},
        createBackup: async (databasePath: string): Promise<string> => {
          changedBackupRoot = await createExternalStorageDatabaseBackup(databasePath);
          roots.push(changedBackupRoot);
          const database: StorageDatabase = openStorageDatabase({ path: databasePath });
          try {
            migrateStorageDatabaseSchema(database);
          } finally {
            closeStorageDatabase(database);
          }
          return changedBackupRoot;
        },
      },
    })).rejects.toThrow(/External migration backup retained.*schema changed after migration preflight/);
    expect(changedBackupRoot).not.toBeNull();

    const unchangedPath: string = createSchemaV5Database();
    let unchangedBackupRoot: string | null = null;
    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: unchangedPath,
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => {},
        createBackup: async (databasePath: string): Promise<string> => {
          unchangedBackupRoot = await createExternalStorageDatabaseBackup(databasePath);
          roots.push(unchangedBackupRoot);
          return unchangedBackupRoot;
        },
        migrateSchema: (): void => {},
      },
    })).rejects.toThrow(/External migration backup retained.*did not produce schema v7/);
    expect(unchangedBackupRoot).not.toBeNull();
  });

  test("迁移成功但释放锁失败时仍报告并保留外部备份根", async () => {
    const path: string = createSchemaV5Database();
    let backupRoot: string | null = null;
    await expect(runTemporaryWhitelistMigration({
      mode: "apply",
      botToken: "test-token",
      databasePath: path,
      dependencies: {
        acquireLock: async (): Promise<void> => {},
        releaseLock: async (): Promise<void> => {
          throw new Error("injected release failure");
        },
        createBackup: async (databasePath: string): Promise<string> => {
          backupRoot = await createExternalStorageDatabaseBackup(databasePath);
          roots.push(backupRoot);
          return backupRoot;
        },
      },
    })).rejects.toThrow(/External migration backup retained.*lock release failed.*injected release failure/);
    expect(backupRoot).not.toBeNull();
  });

  test("CLI 非法参数与顶层失败均非零退出且不回显 bot token", () => {
    const root: string = temporaryRoot("copy-ninjia-temp-white-cli-");
    const configRoot: string = join(root, "config");
    mkdirSync(configRoot);
    const secret: string = "123456789:TEST_SECRET_MUST_NOT_BE_ECHOED";
    writeFileSync(join(configRoot, "telegram.json"), JSON.stringify({
      bot_token: secret,
      super_admin_user_id: 123456789,
    }));
    const scriptPath: string = join(
      import.meta.dir,
      "../../scripts/migrateTemporaryWhitelist.ts"
    );
    const runCli = (argument: string): CliResult => {
      const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
        cmd: [process.execPath, scriptPath, argument],
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          COPY_NINJIA_CONFIG_ROOT: configRoot,
          COPY_NINJIA_DATA_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stderr: new TextDecoder().decode(result.stderr),
      };
    };

    const invalid: CliResult = runCli("--invalid");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("Usage:");
    expect(invalid.stderr).not.toContain(secret);

    const failed: CliResult = runCli("--check");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("database file is missing");
    expect(failed.stderr).not.toContain(secret);
  });
});
