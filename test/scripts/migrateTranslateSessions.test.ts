import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { initializeStorageDatabase } from "../../packages/database/interact/initialization";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import * as atomicFile from "../../packages/libs/atomicFile";
import { prepareTranslateSessionsMigration } from "../../scripts/migrateTranslateSessions";
import type { TranslateSessionsMigrationResult } from "../../scripts/migrateTranslateSessions";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import { TEST_DATA_ROOT } from "../preloadEnv";

let root: string;
let source: string;
let databasePath: string;
const snapshot: string = JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 });
const primaryState: Readonly<Record<string, unknown>> = {
  global: { copy: { copiedUser: null, lastCopyTime: 12 }, assets: { randomHImageDir: "./images" } },
  translate: {
    "-1001": [{ translatedUser: { id: 7, first_name: "ty" }, language: "cn" }],
    "-2002": [{ translatedUser: { id: 8 }, language: "ja" }, { translatedUser: { id: -3003, title: "Channel", isChannel: true }, language: "en" }],
  },
};
const backupState: Readonly<Record<string, unknown>> = {
  global: { copy: { copiedUser: null, lastCopyTime: 6 } },
  translate: { "-1001": [{ translatedUser: { id: 9 }, language: "uk" }] },
};

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
}

async function sourceHashes(): Promise<readonly string[]> {
  return [await sha256(join(source, "state.json")), await sha256(join(source, "state.json.bak")), await sha256(databasePath)];
}

function run(outputName: string = "output"): Promise<TranslateSessionsMigrationResult> {
  return prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: join(root, outputName) });
}

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "translate-sessions-migration-"));
  source = join(root, "source");
  databasePath = join(source, "database/storage.sqlite");
  await mkdir(join(source, "database"), { recursive: true });
  createStorageDatabase(databasePath);
  const database: StorageDatabase = openStorageDatabase({ path: databasePath });
  try {
    initializeStorageDatabase(database);
  } finally { closeStorageDatabase(database); }
  const client: Database = new Database(databasePath);
  try {
    client.run("INSERT INTO chat_states VALUES (-1001, jsonb('{\"isInitEnabled\":true,\"isTranslationEnabled\":true}'), jsonb(?), '本群人设')", [snapshot]);
  } finally { client.close(true); }
  await Bun.write(join(source, "state.json"), JSON.stringify(primaryState, null, 2));
  await Bun.write(join(source, "state.json.bak"), JSON.stringify(backupState, null, 2));
});

afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("主 state 的会话写进 chat_states，两份 state 去掉 translate，源文件不变", async () => {
  const before: readonly string[] = await sourceHashes();
  const result: TranslateSessionsMigrationResult = await run();
  expect(result).toMatchObject({ migratedChats: 2, migratedSessions: 3, createdChatRows: 1 });
  expect(await sourceHashes()).toEqual(before);
  expect(result.outputFiles.map((file): string => file.path)).toEqual(["state.json", "state.json.bak", "database/storage.sqlite"]);

  const primary: unknown = await Bun.file(join(result.outputRoot, "state.json")).json();
  expect(primary).toEqual({ global: primaryState.global });
  expect(await Bun.file(join(result.outputRoot, "state.json.bak")).json()).toEqual({ global: backupState.global });
  expect(decodeStateFile(primary, "state.json").global.copy.lastCopyTime).toBe(12);

  const client: Database = new Database(join(result.outputRoot, "database/storage.sqlite"), { readonly: true });
  try {
    expect(client.query("SELECT chat_id, json(status) AS status, json(ai_context) AS context, ai_persona FROM chat_states ORDER BY chat_id").all()).toEqual([
      {
        chat_id: -2002,
        status: JSON.stringify({ translate: [
          { translatedUser: { id: 8 }, language: "ja" },
          { translatedUser: { id: -3003, title: "Channel", isChannel: true }, language: "en" },
        ] }),
        context: null,
        ai_persona: null,
      },
      {
        chat_id: -1001,
        status: JSON.stringify({
          isTranslationEnabled: true,
          isInitEnabled: true,
          translate: [{ translatedUser: { id: 7, first_name: "ty" }, language: "cn" }],
        }),
        context: snapshot,
        ai_persona: "本群人设",
      },
    ]);
    expect(client.query("SELECT json(data) AS data FROM storage_metadata").all()).toEqual([{ data: '{"version":11}' }]);
  } finally { client.close(true); }
  expect(await Bun.file(join(result.outputRoot, "ready.json")).exists()).toBeTrue();
  expect(await Bun.file(join(result.outputRoot, "incomplete.json")).exists()).toBeFalse();
});

test("源没有备份副本且主 state 没有 translate 时只输出主 state 与 SQLite", async () => {
  await Bun.file(join(source, "state.json.bak")).delete();
  await Bun.write(join(source, "state.json"), JSON.stringify({ global: primaryState.global }, null, 2));
  const result: TranslateSessionsMigrationResult = await run();
  expect(result).toMatchObject({ migratedChats: 0, migratedSessions: 0, createdChatRows: 0 });
  expect(result.outputFiles.map((file): string => file.path)).toEqual(["state.json", "database/storage.sqlite"]);
});

test.each(["version", "lineage", "existing-session", "state", "capacity"])("非法 %s 不产生 ready，源副本保持不变", async (kind: string) => {
  const client: Database = new Database(databasePath);
  try {
    if (kind === "version") client.run("UPDATE storage_metadata SET data = jsonb('{\"version\":10}')");
    if (kind === "lineage") client.run("DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)");
    if (kind === "existing-session") {
      client.run("UPDATE chat_states SET status = jsonb(?) WHERE chat_id = -1001", [
        JSON.stringify({ isInitEnabled: true, translate: [{ translatedUser: { id: 1 }, language: "ja" }] }),
      ]);
    }
    if (kind === "capacity") {
      for (let index: number = 1; index < STATE_MANAGED_CHAT_LIMIT; index++) {
        client.run("INSERT INTO chat_states (chat_id, status) VALUES (?, jsonb('{\"isInitEnabled\":true}'))", [-5000 - index]);
      }
    }
  } finally { client.close(true); }
  if (kind === "state") {
    await Bun.write(join(source, "state.json"), JSON.stringify({ ...primaryState, translate: { "-1001": [{ translatedUser: { id: 7 }, language: "zh" }] } }));
  }
  const before: readonly string[] = await sourceHashes();
  await expect(run()).rejects.toThrow();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await sourceHashes()).toEqual(before);
});

test("不覆盖既有输出，中断后在新输出目录重跑", async () => {
  await mkdir(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(run("interrupted")).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(run("retry")).resolves.toMatchObject({ migratedChats: 2 });
});

test("写 state 产物中途失败时保留 incomplete，不产生 ready", async () => {
  const original = atomicFile.atomicWriteText;
  spyOn(atomicFile, "atomicWriteText").mockImplementation(async (path: string, ...rest: unknown[]): Promise<void> => {
    if (path.endsWith("state.json.bak")) throw new Error("disk full");
    await (original as (...args: unknown[]) => Promise<void>)(path, ...rest);
  });
  await expect(run()).rejects.toThrow("disk full");
  expect(await Bun.file(join(root, "output/incomplete.json")).exists()).toBeTrue();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
});

test("输出与源根互相包含时拒绝", async () => {
  await expect(prepareTranslateSessionsMigration({ sourceRoot: source, outputRoot: join(source, "nested") })).rejects.toThrow("a new directory outside the source backup");
});
