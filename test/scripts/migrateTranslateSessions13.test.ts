import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseAgentDeploymentConfig } from "../../packages/config/agent";
import { openStorageDatabase, closeStorageDatabase } from "../../packages/database/interact/connection";
import { validateStorageDatabase } from "../../packages/database/interact/validation";
import { readMigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import { prepareTranslateSessionsMigration } from "../../scripts/migrateTranslateSessions";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import type { StorageDatabaseInspection } from "../../packages/types/identityStorage";
import type { TranslateSessionsMigrationResult } from "../../scripts/migrateTranslateSessions";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** 直接前序 13.0.2 的固定产物，不调用当前建库器生成迁移输入。 */
const FIXTURE_ROOT: string = join(import.meta.dir, "../fixtures/migrations/13.0.2");
/** 翻译会话迁移必须逐行保留的业务表、版本元数据与迁移谱系。 */
const TABLES: readonly string[] = [
  "permission_list", "blocklist_entries", "pending_blocked_removals", "temporary_ad_bypass_entries",
  "chat_qa", "storage_metadata", "__drizzle_migrations",
];
let root: string;
let source: string;
let databasePath: string;

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "migration-13-"));
  source = join(root, "source");
  databasePath = join(source, "database/storage.sqlite");
  await mkdir(join(source, "database"), { recursive: true });
  const client: Database = new Database(databasePath, { create: true });
  try { client.run(await Bun.file(join(FIXTURE_ROOT, "storage.sql")).text()); } finally { client.close(true); }
  await Bun.write(join(source, "state.json"), Bun.file(join(FIXTURE_ROOT, "state.fixture.json")));
});

afterEach(async (): Promise<void> => { await rm(root, { recursive: true, force: true }); });

async function sourceSnapshot(): Promise<readonly unknown[]> {
  const entries: unknown[] = [];
  for (const name of ["state.json", "database/storage.sqlite", "database/storage.sqlite-wal", "database/storage.sqlite-shm"]) {
    entries.push(await readMigrationFileSnapshot(join(source, name)));
  }
  return entries;
}

function preservedRows(path: string): readonly unknown[] {
  const client: Database = new Database(path, { readonly: true });
  try {
    return [
      ...TABLES.map((name: string): unknown => client.query(`SELECT * FROM ${name} ORDER BY 1`).all()),
      client.query("SELECT ai_context, ai_persona FROM chat_states WHERE chat_id = -1001").get(),
    ];
  } finally { client.close(true); }
}

test.each([false, true])("13.0.2 非空库迁移并保留非迁移字段（WAL=%s）", async (wal: boolean): Promise<void> => {
  const expected: readonly unknown[] = preservedRows(databasePath);
  if (wal) {
    const livePath: string = join(root, "live.sqlite");
    await Bun.write(livePath, Bun.file(databasePath));
    const live: Database = new Database(livePath);
    try {
      live.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      live.run("UPDATE chat_states SET status = jsonb_set(status, '$.isAIChatEnabled', json('false'))");
      live.run("UPDATE chat_states SET status = jsonb_set(status, '$.isAIChatEnabled', json('true'))");
      for (const suffix of ["", "-wal", "-shm"]) {
        await Bun.write(`${databasePath}${suffix}`, Bun.file(`${livePath}${suffix}`));
      }
    } finally { live.close(true); }
    expect((await Bun.file(`${databasePath}-wal`).stat()).size).toBeGreaterThan(0);
  }
  const before: readonly unknown[] = await sourceSnapshot();
  const output: string = join(root, "output");
  const result: TranslateSessionsMigrationResult = await prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: output });
  expect(result).toMatchObject({ migratedChats: 2, migratedSessions: 2, createdChatRows: 1 });
  expect(await sourceSnapshot()).toEqual(before);
  const outputPath: string = join(output, "database/storage.sqlite");
  expect(preservedRows(outputPath)).toEqual(expected);
  const database: StorageDatabase = openStorageDatabase({ path: outputPath, readonly: true });
  try {
    const inspection: StorageDatabaseInspection = validateStorageDatabase(database, outputPath);
    expect(inspection.hydration.chatStates.get(-1001)?.translate?.[0]?.language).toBe("en");
    expect(inspection.hydration.chatStates.get(-1002)?.translate?.[0]?.language).toBe("uk");
    expect(inspection.aiMemories.size).toBe(1);
    expect(inspection.hydration.pendingBlockedRemovals.size).toBe(1);
  } finally { closeStorageDatabase(database); }
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeTrue();
  await expect(prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow();
  expect(await sourceSnapshot()).toEqual(before);
});

test.each([
  ["permission_list", "UPDATE permission_list SET policy=jsonb('{}')"],
  ["chat_qa", "UPDATE chat_qa SET data=jsonb('{\"a\":42}')"],
  ["pending_blocked_removals", "DELETE FROM blocklist_entries"],
  ["ai_context", "UPDATE chat_states SET ai_context=jsonb('{\"version\":999}')"],
  ["lineage", "UPDATE __drizzle_migrations SET hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
])("13.0.2 非法 %s：完整校验与 CLI 均拒绝且保留源", async (field: string, sql: string): Promise<void> => {
  const client: Database = new Database(databasePath);
  try { client.run(sql); } finally { client.close(true); }
  const database: StorageDatabase = openStorageDatabase({ path: databasePath, readonly: true });
  try { expect((): unknown => validateStorageDatabase(database, databasePath)).toThrow(field); } finally { closeStorageDatabase(database); }
  const before: readonly unknown[] = await sourceSnapshot();
  const output: string = join(root, "output");
  const child: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: [Bun.argv[0]!, join(import.meta.dir, "../../scripts/migrateTranslateSessions.ts"), "--source-root", source, "--output-root", output],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", COPY_NINJIA_DATA_ROOT: source, COPY_NINJIA_CONFIG_ROOT: join(root, "absent-config") },
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  expect(child.exitCode).not.toBe(0);
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeTrue();
  expect(await sourceSnapshot()).toEqual(before);
});

test("13.0.2 无翻译会话与中断后换目录续跑", async (): Promise<void> => {
  const state: { readonly global: unknown } = await Bun.file(join(source, "state.json")).json();
  await Bun.write(join(source, "state.json"), JSON.stringify({ global: state.global }));
  const before: readonly unknown[] = await sourceSnapshot();
  const interrupted: string = join(root, "interrupted");
  await mkdir(interrupted);
  await Bun.write(join(interrupted, "incomplete.json"), "preserve");
  await expect(prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: interrupted })).rejects.toThrow();
  expect(await Bun.file(join(interrupted, "incomplete.json")).text()).toBe("preserve");
  await expect(prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: join(root, "retry") }))
    .resolves.toMatchObject({ migratedChats: 0, migratedSessions: 0, createdChatRows: 0 });
  expect(await sourceSnapshot()).toEqual(before);
});

test("迁移写入后完整复验，产物问答异常不得生成 ready", async (): Promise<void> => {
  const client: Database = new Database(databasePath);
  try {
    client.run("CREATE TRIGGER corrupt_qa AFTER UPDATE OF status ON chat_states BEGIN UPDATE chat_qa SET data=jsonb('{\"a\":42}'); END");
  } finally { client.close(true); }
  const before: readonly unknown[] = await sourceSnapshot();
  const output: string = join(root, "output");
  await expect(prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow("chat_qa");
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeTrue();
  expect(await sourceSnapshot()).toEqual(before);
});

test("13.0.2 配置必须手工去掉 song，tts 必须显式指定音色", async (): Promise<void> => {
  const document: { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> } = await Bun.file(join(FIXTURE_ROOT, "agent.json")).json();
  expect((): unknown => parseAgentDeploymentConfig(document.agent, "fixture/agent.json")).toThrow("$.agent must be exactly");
  const { song, ...capabilities }: Readonly<Record<string, Readonly<Record<string, unknown>>>> = document.agent;
  expect((): unknown => parseAgentDeploymentConfig(capabilities, "fixture/agent.json")).not.toThrow();
  const tts: Readonly<Record<string, unknown>> = { ...song, model: "fixture-tts-model", voice: "Leda" };
  expect(parseAgentDeploymentConfig({ ...capabilities, tts }, "fixture/agent.json")?.tts?.voice).toBe("Leda");
  expect((): unknown => parseAgentDeploymentConfig({ ...capabilities, tts: song }, "fixture/agent.json")).toThrow("voice");
});
