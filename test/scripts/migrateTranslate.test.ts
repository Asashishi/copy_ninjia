import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTranslationMigration } from "../../scripts/migrateTranslate";
import { migrateTranslationState } from "../../scripts/migrations/translate/state";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT } from "../../packages/consts/identityStorage";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { openStorageDatabase, closeStorageDatabase } from "../../packages/database/interact/connection";
import { decodeWhitelistEntryData } from "../../packages/database/codec/identity";
import { decodeChatStateData } from "../../packages/database/codec/chatState";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import type { TranslationMigrationOptions, TranslationMigrationResult } from "../../scripts/migrateTranslate";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databaseAt(root: string): StorageDatabase {
  return openStorageDatabase({ path: join(root, "database/storage.sqlite") });
}

async function fixture(): Promise<TranslationMigrationOptions> {
  const root: string = mkdtempSync(join(tmpdir(), "translate-migration-"));
  roots.push(root);
  const sourceRoot: string = join(root, "source");
  mkdirSync(join(sourceRoot, "database"), { recursive: true });
  createStorageDatabase(join(sourceRoot, "database/storage.sqlite"));
  const database: StorageDatabase = databaseAt(sourceRoot);
  try {
    database.$client.run("DELETE FROM __drizzle_migrations WHERE created_at = ?;", [IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT]);
    database.$client.run("INSERT INTO storage_metadata (key, data) VALUES ('schema-version', jsonb('{\"version\":7}'));");
    for (const [id, granted] of [[7, true], [8, false]] as const) {
      const { isCanControllTranslatePermission: _permission, ...permissions } = DEFAULT_WHITELIST_PERMISSIONS;
      database.$client.run("INSERT INTO whitelist_entries (id, data) VALUES (?, jsonb(?));", [id, JSON.stringify({
        permissions: { ...permissions, isCanControllJATranslatePermission: granted },
        meta: { firstName: "Target", lastName: "", username: `target${id}` },
      })]);
    }
    for (const [chatId, enabled] of [[-1001, true], [-2002, false], [-3003, undefined]] as const) {
      database.$client.run("INSERT INTO chat_states (chat_id, data) VALUES (?, jsonb(?));", [chatId, JSON.stringify({
        title: "Group", isJATranslationEnabled: enabled, isInitEnabled: true,
      })]);
    }
  } finally {
    closeStorageDatabase(database);
  }
  const state: string = JSON.stringify({ global: {
    copy: { copiedUser: { id: 7, username: "alice" }, copyChatId: -1001, copyMode: "ja", lastCopyTime: 1_234 },
    assets: { botDefaultAvatarUrl: "https://example.com/avatar.png" },
  } });
  await Bun.write(join(sourceRoot, "state.json"), state);
  await Bun.write(join(sourceRoot, "state.json.bak"), state);
  return { sourceRoot, outputRoot: join(root, "output"), from: "10.5.4" };
}

async function hash(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
}

describe("10.5.4 到多人翻译的冷迁移", () => {
  test("保留 SQLite 原有授权真假值、开关缺省与其它字段，并迁移主备日语目标", async () => {
    const options: TranslationMigrationOptions = await fixture();
    const originalState: string = await hash(join(options.sourceRoot, "state.json"));
    const originalDatabase: string = await hash(join(options.sourceRoot, "database/storage.sqlite"));
    const result: TranslationMigrationResult = await prepareTranslationMigration(options);
    expect(result.sourceRelease).toBe("10.5.4");
    expect(result.targetSchema).toBe(8);
    expect(result.sourceFiles).toHaveLength(3);
    expect(result.outputFiles).toHaveLength(3);
    expect(await Bun.file(join(options.outputRoot, "ready.json")).json()).toEqual(result);
    expect(await Bun.file(join(options.outputRoot, "incomplete.json")).exists()).toBe(false);
    for (const file of result.sourceFiles) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.mode).toBeGreaterThan(0);
      expect(Number.isSafeInteger(file.uid)).toBe(true);
      expect(Number.isSafeInteger(file.gid)).toBe(true);
    }
    for (const path of ["state.json", "state.json.bak"]) {
      const decoded = decodeStateFile(await Bun.file(join(options.outputRoot, path)).json());
      expect(decoded.global.copy).toEqual({ copiedUser: null, lastCopyTime: 1_234 });
      expect(decoded.global.assets.botDefaultAvatarUrl).toBe("https://example.com/avatar.png");
      expect(decoded.translate["-1001"]?.[0]).toMatchObject({ translatedUser: { id: 7, username: "alice" }, language: "ja" });
    }
    const database: StorageDatabase = databaseAt(options.outputRoot);
    try {
      for (const row of database.$client.query<{ id: number; data: string }, []>("SELECT id, json(data) AS data FROM whitelist_entries;").all()) {
        const decoded = decodeWhitelistEntryData(row.data, "output");
        expect(decoded.permissions).toEqual({ ...DEFAULT_WHITELIST_PERMISSIONS, isCanControllTranslatePermission: row.id === 7 });
        expect(row.data).not.toContain("isCanControllJATranslatePermission");
      }
      for (const row of database.$client.query<{ id: number; data: string }, []>("SELECT chat_id AS id, json(data) AS data FROM chat_states;").all()) {
        expect(decodeChatStateData(row.data, "output").isTranslationEnabled).toBe(row.id === -3003 ? undefined : row.id === -1001);
        expect(row.data).not.toContain("isJATranslationEnabled");
        expect(JSON.parse(row.data).title).toBe("Group");
      }
      expect(database.$client.query<{ version: number }, []>("SELECT json_extract(data, '$.version') AS version FROM storage_metadata;").get()?.version).toBe(8);
    } finally {
      closeStorageDatabase(database);
    }
    expect(await hash(join(options.sourceRoot, "state.json"))).toBe(originalState);
    expect(await hash(join(options.sourceRoot, "database/storage.sqlite"))).toBe(originalDatabase);
    await expect(prepareTranslationMigration(options)).rejects.toThrow();
    expect(await Bun.file(join(options.outputRoot, "ready.json")).json()).toEqual(result);
  });

  test("源 WAL 中的已提交授权一起迁移，源主库及旁路文件不改写", async () => {
    const options: TranslationMigrationOptions = await fixture();
    const database: StorageDatabase = databaseAt(options.sourceRoot);
    try {
      database.$client.run("PRAGMA journal_mode=WAL;");
      database.$client.run("PRAGMA wal_autocheckpoint=0;");
      database.$client.run("UPDATE whitelist_entries SET data=jsonb_set(data, '$.permissions.isCanControllJATranslatePermission', jsonb('true')) WHERE id=8;");
      const walHash: string = await hash(join(options.sourceRoot, "database/storage.sqlite-wal"));
      const result: TranslationMigrationResult = await prepareTranslationMigration(options);
      expect(result.sourceFiles).toHaveLength(5);
      expect(await hash(join(options.sourceRoot, "database/storage.sqlite-wal"))).toBe(walHash);
      expect(await Bun.file(join(options.outputRoot, "database/storage.sqlite-wal")).exists()).toBe(false);
      expect(await Bun.file(join(options.outputRoot, "database/storage.sqlite-shm")).exists()).toBe(false);
      for (const file of result.outputFiles) expect(await hash(join(options.outputRoot, file.path))).toBe(file.sha256);
      const output: StorageDatabase = databaseAt(options.outputRoot);
      try {
        expect(output.$client.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get()?.journal_mode).toBe("wal");
        expect(output.$client.query<{ granted: number }, []>("SELECT json_extract(data, '$.permissions.isCanControllTranslatePermission') AS granted FROM whitelist_entries WHERE id=8;").get()?.granted).toBe(1);
      } finally {
        closeStorageDatabase(output);
      }
    } finally {
      closeStorageDatabase(database);
    }
  });

  test.each(["permission-conflict", "permission-type", "permission-missing", "switch-conflict", "switch-type", "lineage", "older-schema", "newer-schema"])("%s 拒绝产出完成标记且保留源文件", async (change: string) => {
    const options: TranslationMigrationOptions = await fixture();
    const database: StorageDatabase = databaseAt(options.sourceRoot);
    try {
      if (change === "permission-conflict") database.$client.run("UPDATE whitelist_entries SET data=jsonb_set(data, '$.permissions.isCanControllTranslatePermission', jsonb('false')) WHERE id=7;");
      if (change === "permission-type") database.$client.run("UPDATE whitelist_entries SET data=jsonb_set(data, '$.permissions.isCanControllJATranslatePermission', 'secret') WHERE id=7;");
      if (change === "permission-missing") database.$client.run("UPDATE whitelist_entries SET data=jsonb_remove(data, '$.permissions.isCanControllJATranslatePermission') WHERE id=7;");
      if (change === "switch-conflict") database.$client.run("UPDATE chat_states SET data=jsonb_set(data, '$.isTranslationEnabled', jsonb('true')) WHERE chat_id=-1001;");
      if (change === "switch-type") database.$client.run("UPDATE chat_states SET data=jsonb_set(data, '$.isJATranslationEnabled', 'secret') WHERE chat_id=-1001;");
      if (change === "lineage") database.$client.run("DELETE FROM __drizzle_migrations WHERE created_at=(SELECT MAX(created_at) FROM __drizzle_migrations);");
      if (change === "older-schema" || change === "newer-schema") database.$client.run("UPDATE storage_metadata SET data=jsonb(?);", [JSON.stringify({ version: change === "older-schema" ? 6 : 8 })]);
    } finally {
      closeStorageDatabase(database);
    }
    const original: string = await hash(join(options.sourceRoot, "database/storage.sqlite"));
    await expect(prepareTranslationMigration(options)).rejects.toThrow();
    expect(await Bun.file(join(options.outputRoot, "ready.json")).exists()).toBe(false);
    expect(await hash(join(options.sourceRoot, "database/storage.sqlite"))).toBe(original);
  });

  test("未知 Release、输出位于源内和源文件符号链接均拒绝", async () => {
    const options: TranslationMigrationOptions = await fixture();
    await expect(prepareTranslationMigration({ ...options, from: "10.5.3" })).rejects.toThrow("release 10.5.4");
    await expect(prepareTranslationMigration({ ...options, outputRoot: join(options.sourceRoot, "nested") })).rejects.toThrow("outside the source backup");
    await Bun.file(join(options.sourceRoot, "state.json.bak")).delete();
    symlinkSync("state.json", join(options.sourceRoot, "state.json.bak"));
    await expect(prepareTranslationMigration(options)).rejects.toThrow("without symbolic links");
  });

  test("SQLite 旁路文件的悬空链接不得当作缺省", async () => {
    const options: TranslationMigrationOptions = await fixture();
    symlinkSync("missing-wal", join(options.sourceRoot, "database/storage.sqlite-wal"));
    await expect(prepareTranslationMigration(options)).rejects.toThrow("without symbolic links");
    expect(await Bun.file(join(options.outputRoot, "ready.json")).exists()).toBe(false);
  });

  test("中断留下的目录不覆盖，从原备份向新目录可完整重跑", async () => {
    const options: TranslationMigrationOptions = await fixture();
    mkdirSync(options.outputRoot);
    await Bun.write(join(options.outputRoot, "incomplete.json"), "interrupted");
    await expect(prepareTranslationMigration(options)).rejects.toThrow();
    expect(await Bun.file(join(options.outputRoot, "incomplete.json")).text()).toBe("interrupted");
    const result: TranslationMigrationResult = await prepareTranslationMigration({ ...options, outputRoot: `${options.outputRoot}-retry` });
    expect(await Bun.file(join(result.outputRoot, "ready.json")).exists()).toBe(true);
  });
});

describe("停机状态转换", () => {
  test.each([undefined, "reverse", "nya"])("普通 copy 模式 %s 保留目标和全部 global 字段", (copyMode: string | undefined) => {
    const input = { global: { copy: { copiedUser: { id: 7 }, copyChatId: -1001, copyMode, lastCopyTime: 42 } } };
    const output = JSON.parse(migrateTranslationState(JSON.stringify(input), "backup/state.json"));
    expect(output.global).toEqual(JSON.parse(JSON.stringify(input.global)));
    expect(output.translate).toEqual({});
  });

  test.each([
    "secret", "{}", '{"global":{"copy":{"copiedUser":null,"copyMode":"ja"}}}',
    '{"global":{"copy":{"copiedUser":null}},"translate":{}}',
    '{"global":{"copy":{"copiedUser":{"id":7},"copyMode":"ja","copyChatId":1001}}}',
  ])("源状态非法或不是已发布形态时整份拒绝", (text: string) => {
    expect(() => migrateTranslationState(text, "backup/state.json")).toThrow("backup/state.json");
  });
});
