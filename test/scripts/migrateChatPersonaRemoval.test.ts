import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { adoptTimeZone } from "../../packages/config/time";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../packages/consts/antiRaid/blocklist";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_VERSION,
} from "../../packages/consts/identityStorage";
import { TOKYO_TIME_ZONE } from "../../packages/consts/time";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { validateStorageDatabase } from "../../packages/database/interact/validation";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import { assertMigratedDatabase, createMigrationDatabase, createSchemaV12Database } from "../../scripts/fixtures/migrationDatabase";
import type { MigrationDatabaseFixture } from "../../scripts/fixtures/migrationDatabase";
import { prepareChatPersonaRemovalMigration } from "../../scripts/migrateChatPersonaRemoval";
import { CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION } from "../../scripts/migrations/chatPersonaRemoval/database";
import type { ChatPersonaRemovalMigrationResult } from "../../scripts/migrateChatPersonaRemoval";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** 仓库根；夹具从这里的迁移 SQL 建出 v11 源库。 */
const PROJECT_ROOT: string = join(import.meta.dir, "../..");

let root: string;
let source: string;

// 与 CLI 入口相同：v11 谱系的日历固定为东京，产物按 Asia/Tokyo 接受完整启动校验。
beforeAll((): void => { adoptTimeZone(TOKYO_TIME_ZONE); });
let path: string;
let fixture: MigrationDatabaseFixture;

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "chat-persona-removal-migration-"));
  source = join(root, "source");
  path = join(source, "database/storage.sqlite");
  fixture = await createMigrationDatabase({ packageRoot: PROJECT_ROOT, root, source });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 源库三件套的逐字节快照，缺省的旁路文件记为 null；迁移必须原样保留。 */
async function sourceBytes(): Promise<readonly (Uint8Array<ArrayBuffer> | null)[]> {
  const files: (Uint8Array<ArrayBuffer> | null)[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file: Bun.BunFile = Bun.file(`${path}${suffix}`);
    files.push(await file.exists() ? await file.bytes() : null);
  }
  return files;
}

test("生产启动校验拒绝真实 v11 冷备份，迁移产物可读且源库与 WAL 不变", async () => {
  const before: readonly (Uint8Array<ArrayBuffer> | null)[] = await sourceBytes();
  const sourceDatabase: StorageDatabase = openStorageDatabase({ path, readonly: true });
  try {
    expect(() => validateStorageDatabase(sourceDatabase, path)).toThrow(
      `${path}: storage_metadata schema-version must be ${IDENTITY_DATABASE_SCHEMA_DATA}.`
    );
  } finally {
    closeStorageDatabase(sourceDatabase);
  }
  // SQLite 只读打开 WAL 库仍可能刷新共享内存索引；数据文件与 WAL 必须保持原样。
  expect((await sourceBytes()).slice(0, 2)).toEqual(before.slice(0, 2));

  const result: ChatPersonaRemovalMigrationResult = await prepareChatPersonaRemovalMigration({
    sourceRoot: source,
    outputRoot: join(root, "output"),
  });
  const outputPath: string = join(result.outputRoot, "database/storage.sqlite");
  const outputDatabase: StorageDatabase = openStorageDatabase({ path: outputPath, readonly: true });
  try {
    expect(validateStorageDatabase(outputDatabase, outputPath).hydration).toMatchObject({
      blocklistEntryCount: 1,
      permissionEntryCount: 2,
    });
  } finally {
    closeStorageDatabase(outputDatabase);
  }
  expect((await sourceBytes()).slice(0, 2)).toEqual(before.slice(0, 2));
});

test("直接删除人设列与 isCanConfigAiPrompt，空状态群行随之删除，其余数据原样保留", async () => {
  const before: readonly (Uint8Array<ArrayBuffer> | null)[] = await sourceBytes();
  const result: ChatPersonaRemovalMigrationResult = await prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({
    sourceSchema: CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION, targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION,
    removedPersonas: 2, removedEmptyChats: 1, removedPermissions: 2,
  });
  expect(result.outputFiles.map((file: { readonly path: string }): string => file.path)).toEqual(["database/storage.sqlite"]);
  expect(await sourceBytes()).toEqual(before);
  assertMigratedDatabase(join(result.outputRoot, "database/storage.sqlite"), fixture);
  expect(await Bun.file(join(result.outputRoot, "ready.json")).exists()).toBeTrue();
  expect(await Bun.file(join(result.outputRoot, "incomplete.json")).exists()).toBeFalse();
});

test.each(["version", "lineage", "lineage-extra", "permission-missing", "permission-type", "context"])("非法来源 %s 不产生 ready，源副本保持不变", async (kind: string) => {
  const client: Database = new Database(path);
  try {
    if (kind === "version") client.run("UPDATE storage_metadata SET data = jsonb('{\"version\":10}')");
    if (kind === "lineage") client.run("DELETE FROM __drizzle_migrations WHERE created_at = 20260908000000");
    if (kind === "lineage-extra") client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('unknown', 20260925000000)");
    if (kind === "permission-missing") client.run("UPDATE permission_list SET policy = jsonb_remove(policy, '$.permissions.isCanConfigAiPrompt') WHERE id = 2");
    if (kind === "permission-type") client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanConfigAiPrompt', 1) WHERE id = 2");
    if (kind === "context") client.run("UPDATE chat_states SET ai_context = jsonb('{\"version\":2}') WHERE chat_id = -1001");
  } finally { client.close(true); }
  const before: readonly (Uint8Array<ArrayBuffer> | null)[] = await sourceBytes();
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await sourceBytes()).toEqual(before);
});

test.each(["context", "orphan"])("空状态 %s 行不能被迁移静默删除", async (kind: string) => {
  const client: Database = new Database(path);
  try {
    if (kind === "context") client.run("UPDATE chat_states SET status = jsonb('{}') WHERE chat_id = -1001");
    else client.run("UPDATE chat_states SET ai_persona = NULL WHERE chat_id = -1002");
  } finally { client.close(true); }
  const before: readonly (Uint8Array<ArrayBuffer> | null)[] = await sourceBytes();
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow("a non-empty state or a persona-only empty state without AI context");
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await sourceBytes()).toEqual(before);
});

test("已是当前 schema 的库不重复迁移", async () => {
  const first: ChatPersonaRemovalMigrationResult = await prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "first") });
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: first.outputRoot, outputRoot: join(root, "second") }))
    .rejects.toThrow(`schema version ${CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION} from the preceding migration`);
  expect(await Bun.file(join(root, "second/ready.json")).exists()).toBeFalse();
});

test("不覆盖既有输出，中断后在新输出目录重跑", async () => {
  await mkdir(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "interrupted") })).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "retry") })).resolves.toMatchObject({ removedPermissions: 2 });
});

test("输出目录不得位于源备份内部", async () => {
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(source, "output") }))
    .rejects.toThrow("a new directory outside the source backup");
});

test("拒绝 8.0.0 之前 dev 构建留下的 text + jsonb 两步基础谱系", async () => {
  // 夹具字面量：被压缩前的两条历史 migration（文本初始建表与文本转 JSONB）。
  const client: Database = new Database(path);
  try {
    client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", [
      "be64993ef4059e0fff1491bdbacc67ee9bb6b6d8097842036c7903c8c4aed93a", 20_260_811_000_000,
    ]);
    client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [
      "cb91b39a954c1638dcdc98e97ea0bfec947ea3cc1c377f39f45834bbda9d0cd3", 20_260_811_010_000,
    ]);
  } finally {
    client.close();
  }
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow("__drizzle_migrations must be the exact schema v11 lineage.");
});

test.each([0, 1])("outbox 容量与生产启动门禁一致：上限加 %s", async (extra: number): Promise<void> => {
  const client: Database = new Database(path);
  try {
    client.run("DELETE FROM pending_blocked_removals");
    const insert = client.query("INSERT INTO pending_blocked_removals VALUES (?, jsonb(?))");
    client.transaction((): void => {
      for (let removalId: number = 1; removalId <= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES + extra; removalId++) {
        insert.run(removalId, JSON.stringify({
          params: { chatId: -1001, probeMembership: true, removalId },
          createdAt: 1000, attempts: 0, lastFailure: null,
        }));
      }
    })();
  } finally { client.close(true); }
  const before: readonly (Uint8Array<ArrayBuffer> | null)[] = await sourceBytes();
  const output: string = join(root, "output");
  const migration: Promise<ChatPersonaRemovalMigrationResult> = prepareChatPersonaRemovalMigration({ sourceRoot: source, outputRoot: output });
  if (extra === 0) await expect(migration).resolves.toMatchObject({ targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION });
  else await expect(migration).rejects.toThrow(`pending_blocked_removals: expected at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows`);
  expect(await Bun.file(join(output, "ready.json")).exists()).toBe(extra === 0);
  expect(await sourceBytes()).toEqual(before);
});

test("已迁到 v12 但缺时区标记的库不被冷迁移接受，源副本保持不变", async () => {
  const v12Root: string = join(root, "v12");
  const v12Source: string = join(v12Root, "source");
  await mkdir(v12Root);
  await createSchemaV12Database({ packageRoot: PROJECT_ROOT, root: v12Root, source: v12Source });
  const v12Path: string = join(v12Source, "database/storage.sqlite");
  const before: Uint8Array<ArrayBuffer> = await Bun.file(v12Path).bytes();
  await expect(prepareChatPersonaRemovalMigration({ sourceRoot: v12Source, outputRoot: join(root, "output") }))
    .rejects.toThrow(`schema version ${CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION} from the preceding migration`);
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await Bun.file(v12Path).bytes()).toEqual(before);
});

test("停机时对 v12 库调用生产 migrate() 只补时区标记迁移，产物与冷迁移一致", async () => {
  const v12Root: string = join(root, "v12");
  const v12Source: string = join(v12Root, "source");
  await mkdir(v12Root);
  const v12: MigrationDatabaseFixture = await createSchemaV12Database({ packageRoot: PROJECT_ROOT, root: v12Root, source: v12Source });
  const v12Path: string = join(v12Source, "database/storage.sqlite");
  const database: StorageDatabase = openStorageDatabase({ path: v12Path });
  try {
    expect(() => validateStorageDatabase(database, v12Path)).toThrow(
      `${v12Path}: storage_metadata schema-version must be ${IDENTITY_DATABASE_SCHEMA_DATA}.`
    );
    migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
    expect(validateStorageDatabase(database, v12Path).hydration).toMatchObject({ blocklistEntryCount: 1, permissionEntryCount: 2 });
  } finally {
    closeStorageDatabase(database);
  }
  assertMigratedDatabase(v12Path, v12);
});

test("全新库上移除群人设与时区标记迁移的条件语句均不生效", async () => {
  const fresh: string = join(root, "fresh.sqlite");
  createStorageDatabase(fresh);
  const client: Database = new Database(fresh, { readonly: true });
  try {
    expect(client.query("SELECT COUNT(*) AS count FROM storage_metadata").get()).toEqual({ count: 0 });
  } finally { client.close(true); }
});
