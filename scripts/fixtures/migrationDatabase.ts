/** 当前冷迁移直接前序（13.x / schema v11，state.json 仍带 translate）的非空数据库夹具。 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS, SUPER_ADMIN_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
} from "../../packages/consts/identityStorage";

/** 迁移不得改动的表：保留原始 SQLite 值，连 JSONB 字节与空值一起比较。 */
const PRESERVED_TABLES: readonly string[] = [
  "permission_list", "blocklist_entries", "pending_blocked_removals", "chat_qa", "temporary_ad_bypass_entries",
];

/** 夹具里已有 chat_states 行的群；迁移只替换它的 status。 */
export const MIGRATION_FIXTURE_CHAT_ID: number = -1001;

export interface MigrationDatabaseFixture {
  readonly preserved: ReadonlyMap<string, readonly unknown[]>;
  readonly chatContext: unknown;
  readonly lineage: readonly unknown[];
}

export interface CreateMigrationDatabaseOptions {
  readonly packageRoot: string;
  readonly root: string;
  readonly source: string;
  readonly historical?: boolean;
}

/** 以发行包自带的迁移 SQL 建出 v11 库；从持有未 checkpoint WAL 的测试库复制一致性快照，源三件套不再打开。 */
export async function createMigrationDatabase({
  packageRoot, root, source, historical = false,
}: CreateMigrationDatabaseOptions): Promise<MigrationDatabaseFixture> {
  await mkdir(join(source, "database"), { recursive: true });
  const livePath: string = join(root, "fixture.sqlite");
  const client: Database = new Database(livePath, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: join(packageRoot, "packages/database/schema/migrations") });
    client.run("PRAGMA journal_mode = WAL");
    client.run("PRAGMA wal_autocheckpoint = 0");
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb('{\"version\":11}'))");
    if (historical) {
      client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", [
        IDENTITY_DATABASE_TEXT_MIGRATION_HASH, IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      ]);
      client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [IDENTITY_DATABASE_JSONB_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT]);
    }
    for (const [index, permissions] of [SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS].entries()) {
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
    client.run("INSERT INTO chat_states VALUES (?, jsonb(?), jsonb(?), ?)", [
      MIGRATION_FIXTURE_CHAT_ID,
      JSON.stringify({ isInitEnabled: true, isAIChatEnabled: true, isTranslationEnabled: true }),
      JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 }),
      "迁移前的本群人设",
    ]);
    client.run("INSERT INTO chat_qa VALUES (-1001, '迁移问题', jsonb('{\"a\":\"保留答案\"}'))");
    client.run("INSERT INTO temporary_ad_bypass_entries VALUES (99, 0, NULL, 0, 1, 1000, NULL)");
    const preserved: Map<string, readonly unknown[]> = new Map();
    for (const table of PRESERVED_TABLES) preserved.set(table, client.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const chatContext: unknown = client.query("SELECT ai_context, ai_persona FROM chat_states WHERE chat_id = ?").get(MIGRATION_FIXTURE_CHAT_ID);
    const lineage: readonly unknown[] = client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.write(join(source, `database/storage.sqlite${suffix}`), Bun.file(`${livePath}${suffix}`));
    }
    if ((await Bun.file(join(source, "database/storage.sqlite-wal")).stat()).size === 0) throw new Error("Expected nonempty WAL fixture.");
    return { preserved, chatContext, lineage };
  } finally { client.close(true); }
}

/**
 * 迁移只能替换 chat_states 的 status：其余业务表、AI 上下文、人设、schema 版本与谱系
 * 必须逐行、逐字节相同，expectedTranslate 为各群迁入后的会话。
 */
export function assertMigratedDatabase(
  path: string,
  expected: MigrationDatabaseFixture,
  expectedTranslate: ReadonlyMap<number, unknown>
): void {
  const client: Database = new Database(path, { readonly: true });
  try {
    for (const [table, rows] of expected.preserved) expect<readonly unknown[]>(client.query(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(rows);
    expect(client.query("SELECT ai_context, ai_persona FROM chat_states WHERE chat_id = ?").get(MIGRATION_FIXTURE_CHAT_ID)).toEqual(expected.chatContext);
    for (const [chatId, translate] of expectedTranslate) {
      const row: { translate: string } | null = client.query<{ translate: string }, [number]>(
        "SELECT json_extract(status, '$.translate') AS translate FROM chat_states WHERE chat_id = ?"
      ).get(chatId);
      expect(JSON.parse(row?.translate ?? "null")).toEqual(translate);
    }
    expect(client.query("SELECT json(data) AS data FROM storage_metadata").all()).toEqual([{ data: '{"version":11}' }]);
    expect<readonly unknown[]>(client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(expected.lineage);
    expect(client.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { client.close(true); }
}
