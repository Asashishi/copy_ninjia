/** 当前冷迁移直接前序（12.1.0 / schema v10）的非空数据库夹具。 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expect } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS, SUPER_ADMIN_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type { WhitelistPermissions } from "../../packages/types/identityPolicy";
import {
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
} from "../../packages/consts/identityStorage";

/** 每张非迁移表保留原始 SQLite 值，连 JSONB 字节与空值一起比较。 */
const PRESERVED_TABLES: readonly string[] = [
  "blocklist_entries", "pending_blocked_removals", "chat_states", "chat_qa", "temporary_ad_bypass_entries",
];

export interface MigrationDatabaseFixture {
  readonly preserved: ReadonlyMap<string, readonly unknown[]>;
  readonly permissions: readonly unknown[];
  readonly lineage: readonly unknown[];
}

export interface CreateMigrationDatabaseOptions {
  readonly packageRoot: string;
  readonly root: string;
  readonly source: string;
  readonly historical?: boolean;
}

/** 固定 v10 终点；从持有未 checkpoint WAL 的测试库复制一致性快照，源三件套不再打开。 */
export async function createMigrationDatabase({
  packageRoot, root, source, historical = false,
}: CreateMigrationDatabaseOptions): Promise<MigrationDatabaseFixture> {
  const migrations: string = join(root, "schema-v10");
  await mkdir(join(source, "database"), { recursive: true });
  await mkdir(join(migrations, "meta"), { recursive: true });
  const packaged: string = join(packageRoot, "packages/database/schema/migrations");
  const journal: { entries: { tag: string }[] } = await Bun.file(join(packaged, "meta/_journal.json")).json() as { entries: { tag: string }[] };
  const last: { tag: string } | undefined = journal.entries.pop();
  if (last?.tag !== "0009_h_image_add_permission" || journal.entries.at(-1)?.tag !== "0008_clear_context_permission") {
    throw new Error("Migration fixture requires the direct schema v10 → v11 edge.");
  }
  await Bun.write(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await Bun.write(join(migrations, `${entry.tag}.sql`), Bun.file(join(packaged, `${entry.tag}.sql`)));
  }
  const livePath: string = join(root, "fixture.sqlite");
  const client: Database = new Database(livePath, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: migrations });
    client.run("PRAGMA journal_mode = WAL");
    client.run("PRAGMA wal_autocheckpoint = 0");
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb('{\"version\":10}'))");
    if (historical) {
      client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?", [
        IDENTITY_DATABASE_TEXT_MIGRATION_HASH, IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      ]);
      client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [IDENTITY_DATABASE_JSONB_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT]);
    }
    for (const [index, permissions] of [SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS].entries()) {
      const { isCanAddHImage: _add, ...previous }: Readonly<WhitelistPermissions> = permissions;
      client.run("INSERT INTO permission_list VALUES (?, jsonb(?))", [index + 1, JSON.stringify({
        permissions: previous, meta: { firstName: "迁移测试", lastName: "名", username: "fixture" },
      })]);
    }
    client.run("INSERT INTO blocklist_entries VALUES (7, jsonb(?))", [JSON.stringify({
      blockedAt: "2026/09/15 00:00:00", meta: { firstName: "blocked", lastName: "", username: "" },
    })]);
    client.run("INSERT INTO pending_blocked_removals VALUES (1, jsonb(?))", [JSON.stringify({
      params: { chatId: -1001, probeMembership: false, userIds: [7], removalId: 1 },
      createdAt: 1, attempts: 0, lastFailure: null,
    })]);
    client.run("INSERT INTO chat_states VALUES (-1001, jsonb(?), jsonb(?), ?)", [
      JSON.stringify({ isInitEnabled: true, isAIChatEnabled: true }),
      JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 }),
      "迁移前的本群人设",
    ]);
    client.run("INSERT INTO chat_qa VALUES (-1001, '迁移问题', jsonb('{\"a\":\"保留答案\"}'))");
    client.run("INSERT INTO temporary_ad_bypass_entries VALUES (99, 0, NULL, 0, 1, 1000, NULL)");
    const preserved: Map<string, readonly unknown[]> = new Map();
    for (const table of PRESERVED_TABLES) preserved.set(table, client.query(`SELECT * FROM ${table} ORDER BY 1`).all());
    const permissions: readonly unknown[] = client.query("SELECT id, json(policy) AS policy FROM permission_list ORDER BY id").all();
    const lineage: readonly unknown[] = client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.write(join(source, `database/storage.sqlite${suffix}`), Bun.file(`${livePath}${suffix}`));
    }
    if ((await Bun.file(join(source, "database/storage.sqlite-wal")).stat()).size === 0) throw new Error("Expected nonempty WAL fixture.");
    return { preserved, permissions, lineage };
  } finally { client.close(true); }
}

/** 迁移只能添加权限位与谱系条目；其余业务表必须逐行、逐字节相同。 */
export function assertMigratedDatabase(path: string, expected: MigrationDatabaseFixture): void {
  const client: Database = new Database(path, { readonly: true });
  try {
    for (const [table, rows] of expected.preserved) expect<readonly unknown[]>(client.query(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(rows);
    expect<readonly unknown[]>(client.query("SELECT id, json(jsonb_remove(policy, '$.permissions.isCanAddHImage')) AS policy FROM permission_list ORDER BY id").all()).toEqual(expected.permissions);
    expect(client.query("SELECT id, json_type(policy, '$.permissions.isCanAddHImage') AS enabled FROM permission_list ORDER BY id").all()).toEqual([
      { id: 1, enabled: "true" }, { id: 2, enabled: "false" },
    ]);
    expect(client.query("SELECT json(data) AS data FROM storage_metadata").all()).toEqual([{ data: '{"version":11}' }]);
    const lineage: readonly unknown[] = client.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
    expect<readonly unknown[]>(lineage.slice(0, -1)).toEqual(expected.lineage);
    expect(lineage.length).toBe(expected.lineage.length + 1);
    expect(client.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { client.close(true); }
}
