import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { IDENTITY_DATABASE_MIGRATIONS_DIR } from "../../packages/consts/identityStorage";
import { SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { prepareAiContextMigration } from "../../scripts/migrateAiContext";
import type { AiContextMigrationResult } from "../../scripts/migrateAiContext";
import { TEST_DATA_ROOT } from "../preloadEnv";

let root: string;
let source: string;
let path: string;
const snapshot: string = JSON.stringify({ version: 1, buffer: [], summaries: ["历史上下文"], pendingSummary: null, savedAt: 1 });

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "ai-context-migration-"));
  source = join(root, "source");
  path = join(source, "database/storage.sqlite");
  const migrations: string = join(root, "schema-v8");
  await mkdir(join(source, "database"), { recursive: true });
  await mkdir(join(source, "memory/ai"), { recursive: true });
  await mkdir(join(migrations, "meta"), { recursive: true });
  const journal = await Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, "meta/_journal.json")).json();
  journal.entries.pop();
  await Bun.write(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) await Bun.write(join(migrations, `${entry.tag}.sql`), Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, `${entry.tag}.sql`)));
  const client: Database = new Database(path, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: migrations });
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb('{\"version\":8}'))");
    client.run("INSERT INTO chat_states VALUES (-1001, jsonb('{\"isInitEnabled\":true,\"isAIChatEnabled\":true}'))");
    for (const [index, permissions] of [SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS].entries()) {
      const { isCanConfigAiPrompt: _prompt, ...previous } = permissions;
      client.run("INSERT INTO whitelist_entries VALUES (?, jsonb(?))", [index + 1, JSON.stringify({ permissions: previous, meta: { firstName: "fixture", lastName: "", username: "" } })]);
    }
    client.run("INSERT INTO temporary_whitelist_entries VALUES (99, 0, NULL, 0, 1, 1000, NULL)");
  } finally { client.close(true); }
  await Bun.write(join(source, "memory/ai/-1001.json"), snapshot);
  await Bun.write(join(source, "memory/ai/-9999.json"), snapshot);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("直接迁移保留已管群上下文，丢弃无主键记忆并按原全部权限授予新权限", async () => {
  const before: string = new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
  const result: AiContextMigrationResult = await prepareAiContextMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({ sourceSchema: 8, targetSchema: 9, importedContexts: 1, discardedContexts: 1 });
  expect(new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex")).toBe(before);
  expect(await Bun.file(join(source, "memory/ai/-9999.json")).text()).toBe(snapshot);
  const client: Database = new Database(join(result.outputRoot, "database/storage.sqlite"), { readonly: true });
  try {
    expect(client.query("SELECT chat_id, typeof(status) AS status, typeof(ai_context) AS context, json(ai_context) AS snapshot, ai_persona FROM chat_states").all())
      .toEqual([{ chat_id: -1001, status: "blob", context: "blob", snapshot, ai_persona: null }]);
    expect(client.query("SELECT id, json_extract(policy, '$.permissions.isCanConfigAiPrompt') AS enabled FROM permission_list ORDER BY id").all()).toEqual([{ id: 1, enabled: 1 }, { id: 2, enabled: 0 }]);
    expect(client.query("SELECT * FROM temporary_ad_bypass_entries").get()).toEqual({ id: 99, ad_bypass: 0, ad_bypass_granted_at: null, qualified_days: 0, send_count: 1, counted_at: 1000, qualified_at: null });
    expect(client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('whitelist_entries', 'temporary_whitelist_entries')").all()).toEqual([]);
  } finally { client.close(true); }
  expect(await Bun.file(join(result.outputRoot, "ready.json")).exists()).toBeTrue();
  expect(await Bun.file(join(result.outputRoot, "incomplete.json")).exists()).toBeFalse();
});

test.each(["version", "lineage", "permission", "context"])("非法 %s 不产生 ready，源副本保持不变", async (kind) => {
  const client: Database = new Database(path);
  try {
    if (kind === "version") client.run("UPDATE storage_metadata SET data = jsonb('{\"version\":7}')");
    if (kind === "lineage") client.run("DELETE FROM __drizzle_migrations WHERE created_at = 20260908000000");
    if (kind === "permission") client.run("UPDATE whitelist_entries SET data = jsonb_remove(data, '$.permissions.isCanMute')");
  } finally { client.close(true); }
  if (kind === "context") await Bun.write(join(source, "memory/ai/-1001.json"), '{"version":2}');
  const before: Uint8Array<ArrayBuffer> = await Bun.file(path).bytes();
  await expect(prepareAiContextMigration({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("不覆盖既有输出，中断后在新输出目录重跑", async () => {
  await mkdir(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(prepareAiContextMigration({ sourceRoot: source, outputRoot: join(root, "interrupted") })).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(prepareAiContextMigration({ sourceRoot: source, outputRoot: join(root, "retry") })).resolves.toMatchObject({ importedContexts: 1 });
});
