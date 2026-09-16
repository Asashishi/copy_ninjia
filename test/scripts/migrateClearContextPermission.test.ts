import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../packages/consts/antiRaid/blocklist";
import { IDENTITY_DATABASE_MIGRATIONS_DIR, IDENTITY_DATABASE_TEXT_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT } from "../../packages/consts/identityStorage";
import { SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS, WHITELIST_PERMISSION_KEYS } from "../../packages/consts/whitelist";
import { prepareClearContextPermissionMigration, readMigrationFileRecord } from "../../scripts/migrateClearContextPermission";
import type { ClearContextPermissionMigrationResult } from "../../scripts/migrateClearContextPermission";
import { TEST_DATA_ROOT } from "../preloadEnv";
import * as atomicFile from "../../packages/libs/atomicFile";

let root: string;
let source: string;
let path: string;
const snapshot: string = JSON.stringify({ version: 1, buffer: [], summaries: ["历史上下文"], pendingSummary: null, savedAt: 1 });

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "clear-context-permission-migration-"));
  source = join(root, "source");
  path = join(source, "database/storage.sqlite");
  const migrations: string = join(root, "schema-v9");
  await mkdir(join(source, "database"), { recursive: true });
  await mkdir(join(migrations, "meta"), { recursive: true });
  const journal = await Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, "meta/_journal.json")).json();
  journal.entries.pop();
  await Bun.write(join(migrations, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) await Bun.write(join(migrations, `${entry.tag}.sql`), Bun.file(join(IDENTITY_DATABASE_MIGRATIONS_DIR, `${entry.tag}.sql`)));
  const client: Database = new Database(path, { create: true });
  try {
    migrate(drizzle(client), { migrationsFolder: migrations });
    client.run("INSERT INTO storage_metadata VALUES ('schema-version', jsonb('{\"version\":9}'))");
    client.run("INSERT INTO chat_states VALUES (-1001, jsonb('{\"isInitEnabled\":true,\"isAIChatEnabled\":true}'), jsonb(?), '本群人设')", [snapshot]);
    for (const [index, permissions] of [SUPER_ADMIN_WHITELIST_PERMISSIONS, DEFAULT_WHITELIST_PERMISSIONS].entries()) {
      const { isCanClearContext: _clear, ...previous } = permissions;
      client.run("INSERT INTO permission_list VALUES (?, jsonb(?))", [index + 1, JSON.stringify({ permissions: previous, meta: { firstName: "fixture", lastName: "", username: "" } })]);
    }
    client.run("INSERT INTO temporary_ad_bypass_entries VALUES (99, 0, NULL, 0, 1, 1000, NULL)");
  } finally { client.close(true); }
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("直接迁移仅增加清理权限，原有全部权限开启的成员获得新权限", async () => {
  const before: string = new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
  const result: ClearContextPermissionMigrationResult = await prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({ sourceSchema: 9, targetSchema: 10, enabledPermissions: 1, disabledPermissions: 1 });
  expect(new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex")).toBe(before);
  const client: Database = new Database(join(result.outputRoot, "database/storage.sqlite"), { readonly: true });
  try {
    expect(client.query("SELECT chat_id, typeof(status) AS status, typeof(ai_context) AS context, json(ai_context) AS snapshot, ai_persona FROM chat_states").all())
      .toEqual([{ chat_id: -1001, status: "blob", context: "blob", snapshot, ai_persona: "本群人设" }]);
    expect(client.query("SELECT id, json_extract(policy, '$.permissions.isCanClearContext') AS enabled FROM permission_list ORDER BY id").all()).toEqual([{ id: 1, enabled: 1 }, { id: 2, enabled: 0 }]);
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
    if (kind === "permission") client.run("UPDATE permission_list SET policy = jsonb_remove(policy, '$.permissions.isCanMute')");
    if (kind === "context") client.run("UPDATE chat_states SET ai_context = jsonb('{\"version\":2}')");
  } finally { client.close(true); }
  const before: Uint8Array<ArrayBuffer> = await Bun.file(path).bytes();
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("不覆盖既有输出，中断后在新输出目录重跑", async () => {
  await mkdir(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "interrupted") })).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "retry") })).resolves.toMatchObject({ enabledPermissions: 1 });
});

test.each([0, 1])("outbox 容量与生产启动门禁一致：上限加 %s", async (extra: number): Promise<void> => {
  const client: Database = new Database(path);
  try {
    client.run("INSERT INTO blocklist_entries VALUES (7, jsonb(?))", [JSON.stringify({
      blockedAt: "2026/08/11 00:00:00", meta: { firstName: "blocked", lastName: "", username: "" },
    })]);
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
  const before: Uint8Array<ArrayBuffer> = await Bun.file(path).bytes();
  const output: string = join(root, "output");
  const migration = prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: output });
  if (extra === 0) await expect(migration).resolves.toMatchObject({ targetSchema: 10 });
  else await expect(migration).rejects.toThrow(`pending_blocked_removals must be at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows`);
  expect(await Bun.file(join(output, "ready.json")).exists()).toBe(extra === 0);
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("任意一项原有权限为 false 时不授予新权限，保留原权限和元数据", async () => {
  const client: Database = new Database(path);
  const expected: Map<number, unknown> = new Map<number, unknown>();
  try {
    let id: number = 10;
    for (const key of WHITELIST_PERMISSION_KEYS) {
      if (key === "isCanClearContext") continue;
      const { isCanClearContext: _clear, ...previous } = SUPER_ADMIN_WHITELIST_PERMISSIONS;
      previous[key] = false;
      const value = { permissions: previous, meta: { firstName: `member-${id}`, lastName: "名", username: "account" } };
      expected.set(id, value);
      client.run("INSERT INTO permission_list VALUES (?, jsonb(?))", [id++, JSON.stringify(value)]);
    }
  } finally { client.close(true); }
  const result = await prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({ enabledPermissions: 1, disabledPermissions: WHITELIST_PERMISSION_KEYS.length });
  const output: Database = new Database(join(result.outputRoot, "database/storage.sqlite"), { readonly: true });
  try {
    for (const [id, value] of expected) {
      const row = output.query<{ original: string; enabled: string }, [number]>("SELECT json(jsonb_remove(policy, '$.permissions.isCanClearContext')) AS original, json_type(policy, '$.permissions.isCanClearContext') AS enabled FROM permission_list WHERE id = ?").get(id)!;
      expect(JSON.parse(row.original)).toEqual(value);
      expect(row.enabled).toBe("false");
    }
  } finally { output.close(true); }
});

test("接受前次迁移产出的历史 JSONB 基础谱系", async () => {
  const client: Database = new Database(path);
  try {
    client.run("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = 20260811000000", [IDENTITY_DATABASE_TEXT_MIGRATION_HASH]);
    client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)", [IDENTITY_DATABASE_JSONB_MIGRATION_HASH, IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT]);
  } finally { client.close(true); }
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .resolves.toMatchObject({ sourceSchema: 9, targetSchema: 10, enabledPermissions: 1 });
});

test.each(["string", "number", "unknown", "already-present", "old-version", "extra-lineage"])("拒绝来源异常 %s，不能通过迁移补齐或覆盖", async (kind) => {
  const client: Database = new Database(path);
  try {
    if (kind === "string") client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanMute', 'true')");
    if (kind === "number") client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanMute', 1)");
    if (kind === "unknown") client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.unknown', jsonb('true'))");
    if (kind === "already-present") client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanClearContext', jsonb('false'))");
    if (kind === "old-version") client.run("UPDATE storage_metadata SET data = jsonb('{\"version\":8}')");
    if (kind === "extra-lineage") client.run("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, 20260915000001)", ["a".repeat(64)]);
  } finally { client.close(true); }
  const before = await Bun.file(path).bytes();
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow();
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("完成后的 v10 不作为 v9 来源再次授权", async () => {
  const result = await prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  const outputPath: string = join(result.outputRoot, "database/storage.sqlite");
  const client: Database = new Database(outputPath);
  try { client.run("UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanClearContext', jsonb('false'))"); } finally { client.close(true); }
  const before = await Bun.file(outputPath).bytes();
  await expect(prepareClearContextPermissionMigration({ sourceRoot: result.outputRoot, outputRoot: join(root, "repeat") })).rejects.toThrow("schema version 9");
  expect(await Bun.file(outputPath).bytes()).toEqual(before);
});

test("迁移事务失败时回滚权限位与谱系，保留不完整产物", async () => {
  const client: Database = new Database(path);
  try { client.run("CREATE TRIGGER reject_migration BEFORE UPDATE ON storage_metadata BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END"); } finally { client.close(true); }
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toMatchObject({ cause: expect.objectContaining({ message: "injected migration failure" }) });
  const output: Database = new Database(join(root, "output/database/storage.sqlite"), { readonly: true });
  try {
    expect(output.query("SELECT json_extract(data, '$.version') AS version FROM storage_metadata").get()).toEqual({ version: 9 });
    expect(output.query("SELECT count(*) AS count FROM permission_list WHERE json_type(policy, '$.permissions.isCanClearContext') IS NOT NULL").get()).toEqual({ count: 0 });
    expect(output.query("SELECT max(created_at) AS latest FROM __drizzle_migrations").get()).toEqual({ latest: 20_260_915_000_000 });
  } finally { output.close(true); }
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(root, "output/incomplete.json")).exists()).toBeTrue();
});

test.each([0, 2 * 1_024 * 1_024, 2 * 1_024 * 1_024 + 17])(
  "清单流式哈希与整文件 SHA-256 一致：%i 字节",
  async (size: number): Promise<void> => {
    const bytes: Uint8Array = new Uint8Array(size);
    for (let index: number = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 17) & 255;
    const relativePath: string = "hash-fixture.bin";
    await Bun.write(join(source, relativePath), bytes);
    const expected: string = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect((await readMigrationFileRecord(source, relativePath)).sha256).toBe(expected);
    const result: ClearContextPermissionMigrationResult = await prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: join(root, "output") });
    for (const record of result.outputFiles) {
      expect(record.sha256).toBe(new Bun.CryptoHasher("sha256")
        .update(await Bun.file(join(result.outputRoot, record.path)).bytes()).digest("hex"));
    }
    expect(await Bun.file(join(result.outputRoot, "ready.json")).json()).toEqual(result);
  }
);

/** 只改目标文件的流式读取，复制、元数据与其余文件仍走真实 Bun 文件 API。 */
function interceptFileStream(
  target: string,
  transform: (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => ReadableStream<Uint8Array<ArrayBuffer>>
): void {
  const originalFile: typeof Bun.file = Bun.file;
  spyOn(Bun, "file").mockImplementation((input: unknown, options?: BlobPropertyBag): ReturnType<typeof Bun.file> => {
    const file: ReturnType<typeof Bun.file> = originalFile(input as string, options);
    if (input === target) {
      const originalStream: typeof file.stream = file.stream.bind(file);
      spyOn(file, "stream").mockImplementation((): ReadableStream<Uint8Array<ArrayBuffer>> => transform(originalStream()));
    }
    return file;
  });
}

test("副本哈希读取中失败时拒绝完成并保留 incomplete 清单", async (): Promise<void> => {
  const before: Uint8Array<ArrayBuffer> = await Bun.file(path).bytes();
  const output: string = join(root, "output");
  const injected: Error = new Error("injected file read failure");
  let chunks: number = 0;
  interceptFileStream(join(output, "database/storage.sqlite"), (stream): ReadableStream<Uint8Array<ArrayBuffer>> =>
    stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk: Uint8Array<ArrayBuffer>, controller: TransformStreamDefaultController<Uint8Array<ArrayBuffer>>): void {
        chunks++;
        controller.enqueue(chunk);
      },
      flush(): never { throw injected; },
    }))
  );
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow(injected);
  expect(chunks).toBeGreaterThan(0);
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeTrue();
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("最终 ready 写入失败时保留 incomplete 清单与完整源备份", async () => {
  const output: string = join(root, "output");
  const before = await Bun.file(path).bytes();
  const original: typeof atomicFile.atomicWriteText = atomicFile.atomicWriteText;
  spyOn(atomicFile, "atomicWriteText").mockImplementation(async (target, content, mode): Promise<void> => {
    if (target === join(output, "ready.json")) throw new Error("injected ready write failure");
    await original(target, content, mode);
  });
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow("injected ready write failure");
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeTrue();
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("源文件在复制期间变化时，最终哈希复核拒绝发布 ready", async (): Promise<void> => {
  const changing: string = path;
  const output: string = join(root, "output");
  interceptFileStream(join(output, "database/storage.sqlite"), (stream): ReadableStream<Uint8Array<ArrayBuffer>> =>
    stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk: Uint8Array<ArrayBuffer>, controller: TransformStreamDefaultController<Uint8Array<ArrayBuffer>>): void {
        const client: Database = new Database(changing);
        try { client.run("UPDATE chat_states SET ai_persona = '发生变化'"); } finally { client.close(true); }
        controller.enqueue(chunk);
      },
    }))
  );
  await expect(prepareClearContextPermissionMigration({ sourceRoot: source, outputRoot: output })).rejects.toThrow("$snapshot");
  expect(await Bun.file(join(output, "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeTrue();
});
