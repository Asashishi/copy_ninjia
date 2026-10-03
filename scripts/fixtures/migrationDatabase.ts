/** 当前冷迁移直接前序（schema v11）的非空数据库夹具；migrate:chat-persona-removal 把它迁到 v13。 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS, SUPER_ADMIN_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT,
  CHAT_PERSONA_REMOVAL_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  TIME_ZONE_MARKER_MIGRATION_CREATED_AT,
  TIME_ZONE_MARKER_MIGRATION_HASH,
} from "../../packages/consts/identityStorage";
import { TOKYO_TIME_ZONE } from "../../packages/consts/time";
import { storageMetadataRows } from "../../packages/database/interact/initialization";
import type { StoredStorageMetadataRow } from "../../packages/types/storageDatabase";
import { CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION } from "../migrations/chatPersonaRemoval/database";

/** 迁移与安装都不得改动的表：保留原始 SQLite 值，连 JSONB 字节与空值一起比较。 */
const PRESERVED_TABLES: readonly string[] = [
  "blocklist_entries", "pending_blocked_removals", "chat_qa", "temporary_ad_bypass_entries",
];

/** 夹具里带状态与人设、迁移后保留状态与上下文的群。 */
const MIGRATION_FIXTURE_CHAT_ID: number = -1001;

/** 夹具里状态为空、仅因人设存在、迁移后整行删除的群。 */
const MIGRATION_FIXTURE_PERSONA_ONLY_CHAT_ID: number = -1002;

/** Drizzle 迁移日志里一条迁移的登记项。 */
interface MigrationJournalEntry {
  readonly tag: string;
  readonly when: number;
}

/** Drizzle 迁移日志；只读取本夹具需要的字段，其余原样写回。 */
interface MigrationJournal {
  readonly entries: MigrationJournalEntry[];
}

export interface MigrationDatabaseFixture {
  readonly preserved: ReadonlyMap<string, readonly unknown[]>;
  readonly chatContext: unknown;
  /** 迁移后 permission_list 应有的逐行值：原 JSONB 去掉 isCanConfigAiPrompt。 */
  readonly permissions: readonly unknown[];
  readonly lineage: readonly unknown[];
}

export interface CreateMigrationDatabaseOptions {
  readonly packageRoot: string;
  readonly root: string;
  readonly source: string;
  readonly historical?: boolean;
}

/**
 * 从发行包自带的迁移 SQL 复制出去掉末尾 drop 条迁移的目录：drop=2 止于 schema v11，drop=1 止于
 * v12（只缺时区标记）。末两条必须依次是移除群人设与时区标记迁移。
 */
async function writeMigrationPrefix(packageRoot: string, target: string, drop: 1 | 2): Promise<void> {
  const migrations: string = join(packageRoot, "packages/database/schema/migrations");
  const journal: MigrationJournal = await Bun.file(join(migrations, "meta/_journal.json")).json() as MigrationJournal;
  if (journal.entries.at(-1)?.when !== TIME_ZONE_MARKER_MIGRATION_CREATED_AT || journal.entries.at(-2)?.when !== CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT) {
    throw new Error("Expected the chat persona removal and time zone marker migrations to be the last journal entries.");
  }
  journal.entries.splice(-drop);
  await mkdir(join(target, "meta"), { recursive: true });
  await Bun.write(join(target, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await Bun.write(join(target, `${entry.tag}.sql`), Bun.file(join(migrations, `${entry.tag}.sql`)));
  }
}

/** 以发行包自带的迁移 SQL 建出 v11 库；从持有未 checkpoint WAL 的测试库复制一致性快照，源三件套不再打开。 */
export async function createMigrationDatabase({
  packageRoot, root, source, historical = false,
}: CreateMigrationDatabaseOptions): Promise<MigrationDatabaseFixture> {
  await mkdir(join(source, "database"), { recursive: true });
  const schemaV11: string = join(root, "schema-v11-migrations");
  await writeMigrationPrefix(packageRoot, schemaV11, 2);
  const livePath: string = join(root, "fixture.sqlite");
  const client: Database = new Database(livePath, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: schemaV11 });
    client.run("PRAGMA journal_mode = WAL");
    client.run("PRAGMA wal_autocheckpoint = 0");
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb(?))", [JSON.stringify({ version: CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION })]);
    if (historical) {
      client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", [
        IDENTITY_DATABASE_TEXT_MIGRATION_HASH, IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      ]);
      client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [IDENTITY_DATABASE_JSONB_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT]);
    }
    for (const [index, permissions] of [
      { ...SUPER_ADMIN_WHITELIST_PERMISSIONS, isCanConfigAiPrompt: true },
      { ...DEFAULT_WHITELIST_PERMISSIONS, isCanConfigAiPrompt: false },
    ].entries()) {
      client.run("INSERT INTO permission_list VALUES (?, jsonb(?))", [index + 1, JSON.stringify({
        permissions, meta: { firstName: "迁移测试", lastName: "名", username: "fixture" },
      })]);
    }
    client.run("INSERT INTO blocklist_entries VALUES (7, jsonb(?))", [JSON.stringify({
      blockedAt: "2026/09/15 00:00:00", meta: { firstName: "blocked", lastName: "", username: "" },
    })]);
    client.run("INSERT INTO pending_blocked_removals VALUES (1, jsonb(?))", [JSON.stringify({
      params: { chatId: -1001, probeMembership: false, userIds: [7], removalId: 1 },
      createdAt: 1, attempts: 0, lastFailure: null,
    })]);
    // Telegram 允许空字符串的名称与群名；迁移与启动都原样保留。
    client.run("INSERT INTO chat_states VALUES (?, jsonb(?), jsonb(?), ?)", [
      MIGRATION_FIXTURE_CHAT_ID,
      JSON.stringify({
        title: "", isInitEnabled: true, isAIChatEnabled: true, isTranslationEnabled: true,
        translate: [{ translatedUser: { id: 7, username: "", first_name: "", last_name: "" }, language: "ja" }],
      }),
      JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 }),
      "迁移前的本群人设",
    ]);
    client.run("INSERT INTO chat_states VALUES (?, jsonb('{}'), NULL, ?)", [MIGRATION_FIXTURE_PERSONA_ONLY_CHAT_ID, "只剩人设的群"]);
    client.run("INSERT INTO chat_qa VALUES (-1001, '迁移问题', jsonb('{\"a\":\"保留答案\"}'))");
    client.run("INSERT INTO temporary_ad_bypass_entries VALUES (99, 0, NULL, 0, 1, 1000, NULL)");
    const preserved: Map<string, readonly unknown[]> = new Map();
    for (const table of PRESERVED_TABLES) preserved.set(table, client.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const chatContext: unknown = client.query("SELECT status, ai_context FROM chat_states WHERE chat_id = ?").get(MIGRATION_FIXTURE_CHAT_ID);
    const permissions: readonly unknown[] = client.query(
      "SELECT id, jsonb_remove(policy, '$.permissions.isCanConfigAiPrompt') AS policy FROM permission_list ORDER BY id"
    ).all();
    const lineage: readonly unknown[] = client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.write(join(source, `database/storage.sqlite${suffix}`), Bun.file(`${livePath}${suffix}`));
    }
    if ((await Bun.file(join(source, "database/storage.sqlite-wal")).stat()).size === 0) throw new Error("Expected nonempty WAL fixture.");
    return { preserved, chatContext, permissions, lineage };
  } finally { client.close(true); }
}

/**
 * v11 夹具再只应用移除群人设迁移得到的 schema v12 库：已应用 0010、缺时区标记。模拟时区标记
 * 迁移发布前就迁到 v12 的部署；冷迁移 CLI 必须拒绝它，停机时由生产 migrate() 只补 0011。
 */
export async function createSchemaV12Database(options: CreateMigrationDatabaseOptions): Promise<MigrationDatabaseFixture> {
  const fixture: MigrationDatabaseFixture = await createMigrationDatabase(options);
  const schemaV12: string = join(options.root, "schema-v12-migrations");
  await writeMigrationPrefix(options.packageRoot, schemaV12, 1);
  const client: Database = new Database(join(options.source, "database/storage.sqlite"));
  try {
    migrate(drizzle(client), { migrationsFolder: schemaV12 });
  } finally { client.close(true); }
  return fixture;
}

/**
 * 迁移产物与夹具逐行、逐字节核对：业务表原样保留，权限只少 isCanConfigAiPrompt，群状态与 AI
 * 上下文保留而 ai_persona 列消失，仅靠人设存在的空群行删除；metadata 恰为当前 schema 版本与
 * Asia/Tokyo 时区标记两行，谱系前进移除群人设与时区标记两条迁移。
 */
export function assertMigratedDatabase(path: string, expected: MigrationDatabaseFixture): void {
  const client: Database = new Database(path, { readonly: true });
  try {
    for (const [table, rows] of expected.preserved) expect<readonly unknown[]>(client.query(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(rows);
    expect<readonly unknown[]>(client.query("SELECT id, policy FROM permission_list ORDER BY id").all()).toEqual(expected.permissions);
    expect(client.query("SELECT status, ai_context FROM chat_states WHERE chat_id = ?").get(MIGRATION_FIXTURE_CHAT_ID)).toEqual(expected.chatContext);
    expect(client.query("SELECT chat_id FROM chat_states ORDER BY chat_id").all()).toEqual([{ chat_id: MIGRATION_FIXTURE_CHAT_ID }]);
    expect(client.query("SELECT name FROM pragma_table_info('chat_states') ORDER BY cid").all())
      .toEqual([{ name: "chat_id" }, { name: "status" }, { name: "ai_context" }]);
    expect<readonly StoredStorageMetadataRow[]>(client.query("SELECT key, json(data) AS data FROM storage_metadata ORDER BY key").all() as StoredStorageMetadataRow[])
      .toEqual(storageMetadataRows(TOKYO_TIME_ZONE));
    expect<readonly unknown[]>(client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual([
      ...expected.lineage,
      { hash: CHAT_PERSONA_REMOVAL_MIGRATION_HASH, created_at: CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT },
      { hash: TIME_ZONE_MARKER_MIGRATION_HASH, created_at: TIME_ZONE_MARKER_MIGRATION_CREATED_AT },
    ]);
    expect(client.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { client.close(true); }
}
