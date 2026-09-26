import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readdirSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FORTUNE_THUMBNAIL_URL } from "../../packages/consts/ui/assets";
import type { GlobalStateMigrationResult } from "../../scripts/migrateGlobalState";
import { readMigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import type { MigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import { TEST_DATA_ROOT } from "../preloadEnv";

// 中断注入：写 ready.json 时抛错。真实模块先展开成普通对象快照再 mock，开关为 false
// 时原样透传（同 test/commands/luckChallenge.test.ts 的 mock.module 用法）。
let interruptReadyWrite: boolean = false;
const realAtomicFile = { ...(await import("../../packages/libs/atomicFile")) };
mock.module("../../packages/libs/atomicFile", () => ({
  ...realAtomicFile,
  atomicWriteText: async (path: string, content: string, mode?: number): Promise<void> => {
    if (interruptReadyWrite && path.endsWith("ready.json")) throw new Error("interrupted");
    await realAtomicFile.atomicWriteText(path, content, mode);
  },
}));
const { prepareGlobalStateMigration } = await import("../../scripts/migrateGlobalState");

let root: string;
let source: string;

const COPY: Readonly<Record<string, unknown>> = {
  copiedUser: { id: 42, first_name: "复读目标" }, copyMode: "nya", copyChatId: -1001, lastCopyTime: 12,
};

function output(name: string = "output"): string {
  return join(root, name);
}

/** 以 14.x 形态写出数据根的 state.json；withBackup 时写一份逐字节相同的备份。 */
async function writeLegacyState(global: Readonly<Record<string, unknown>>, withBackup: boolean = true): Promise<string> {
  const text: string = JSON.stringify({ global }, null, 2);
  await Bun.write(join(source, "state.json"), text);
  if (withBackup) await Bun.write(join(source, "state.json.bak"), text);
  return text;
}

/** 源目录两份文件的快照；迁移前后必须逐字节、逐元数据相同。 */
async function sourceSnapshot(): Promise<readonly (MigrationFileSnapshot | null)[]> {
  return [
    await readMigrationFileSnapshot(join(source, "state.json")),
    await readMigrationFileSnapshot(join(source, "state.json.bak")),
  ];
}

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "global-state-migration-"));
  source = join(root, "data");
  await mkdir(source);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("copy 原样进 memory/global，非缺省素材进 config/dynamic/assets.json，源文件不变", async () => {
  await writeLegacyState({
    copy: COPY,
    assets: {
      randomHImageDir: " ./images ",
      fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
      gagThumbnailUrl: "https://cdn.example/a b.png",
      botDefaultAvatarUrl: "http://assets.internal/face.jpg",
    },
  });
  const before: readonly (MigrationFileSnapshot | null)[] = await sourceSnapshot();

  const result: GlobalStateMigrationResult = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() });

  expect(await Bun.file(join(output(), "memory/global/state.json")).json()).toEqual({ copy: COPY });
  // 与缺省相同的直链不写；目录去掉首尾空白，直链按 URL 归一化。
  expect(await Bun.file(join(output(), "config/dynamic/assets.json")).json()).toEqual({
    random_h_image_dir: "./images",
    gag_thumbnail_url: "https://cdn.example/a%20b.png",
    bot_default_avatar_url: "http://assets.internal/face.jpg",
  });
  expect(result.assetKeys).toEqual(["random_h_image_dir", "gag_thumbnail_url", "bot_default_avatar_url"]);
  expect(result.sourceFiles.map((file): string => file.path)).toEqual(["state.json", "state.json.bak"]);
  expect(result.outputFiles.map((file): string => file.path)).toEqual(["memory/global/state.json", "config/dynamic/assets.json"]);
  expect(readdirSync(output()).sort()).toEqual(["config", "memory", "ready.json"]);
  expect(await Bun.file(join(output(), "ready.json")).json()).toEqual(JSON.parse(JSON.stringify(result)));
  expect(await sourceSnapshot()).toEqual(before);
});

test("没有 assets、素材全是缺省或没有备份时只输出全局状态", async () => {
  await writeLegacyState({ copy: { copiedUser: null } }, false);
  let result: GlobalStateMigrationResult = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output("a") });
  expect(result.assetKeys).toEqual([]);
  expect(await Bun.file(join(output("a"), "memory/global/state.json")).json()).toEqual({ copy: { copiedUser: null } });
  expect(await Bun.file(join(output("a"), "config/dynamic/assets.json")).exists()).toBeFalse();
  expect(result.sourceFiles.map((file): string => file.path)).toEqual(["state.json"]);

  await writeLegacyState({ copy: { copiedUser: null }, assets: { randomHImageDir: "./h_image", fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL } });
  result = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output("b") });
  expect(result.outputFiles.map((file): string => file.path)).toEqual(["memory/global/state.json"]);
});

test("备份副本与主文件不是逐字节相同时拒绝，不产生输出目录", async () => {
  await writeLegacyState({ copy: { copiedUser: null, lastCopyTime: 1 } });
  await Bun.write(join(source, "state.json.bak"), JSON.stringify({ global: { copy: { copiedUser: null, lastCopyTime: 2 } } }));

  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() }))
    .rejects.toThrow(`${join(source, "state.json.bak")}: $sha256 must be identical to state.json; reconcile the two copies manually.`);
  expect(await Bun.file(output()).exists()).toBeFalse();
});

test("未知谱系一律拒绝：已迁移的新格式、13.x translate、14.0.0 之后的 ttsUsage、未知字段与非法取值", async () => {
  const cases: readonly [unknown, string][] = [
    [{ copy: { copiedUser: null } }, "$ must be a 14.x state document with only the global block"],
    [{ global: { copy: { copiedUser: null } }, translate: {} }, "$ must be a 14.x state document with only the global block"],
    [{ global: { copy: { copiedUser: null }, model: {} } }, "$.global must be a 14.x global block"],
    [{ global: { assets: {} } }, "$.global must be a 14.x global block"],
    [{ global: { copy: { copiedUser: null }, assets: { randomImageDir: "./images" } } }, "$.global.assets.randomImageDir must be absent"],
    [{ global: { copy: { copiedUser: null }, assets: { gagThumbnailUrl: "cdn.example/g.png" } } }, "$.global.assets.gagThumbnailUrl must be an absolute URL"],
    [{ global: { copy: { copiedUser: null }, assets: { randomHImageDir: "images" } } }, "$.random_h_image_dir must be an absolute path"],
    [{ global: { copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1, count: 2 } } }, "$.global must be a 14.x global block with copy and optional assets"],
    [{ global: { copy: { copiedUser: null, copyMode: "nya" } } }, "free of copyMode and copyChatId when copiedUser is null"],
  ];
  for (const [index, [document, message]] of cases.entries()) {
    await Bun.write(join(source, "state.json"), JSON.stringify(document));
    await rm(join(source, "state.json.bak"), { force: true });
    await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(`case-${index}`) }))
      .rejects.toThrow(message);
    expect(await Bun.file(output(`case-${index}`)).exists()).toBeFalse();
  }
});

test("源缺主文件或主文件是链接时拒绝；输出目录在源内或已存在时拒绝", async () => {
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() })).rejects.toThrow("state.json");
  await Bun.write(join(root, "elsewhere.json"), JSON.stringify({ global: { copy: { copiedUser: null } } }));
  symlinkSync(join(root, "elsewhere.json"), join(source, "state.json"));
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() }))
    .rejects.toThrow("$type must be a regular file without symbolic links");
  await rm(join(source, "state.json"));

  await writeLegacyState({ copy: { copiedUser: null } });
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: join(source, "nested") }))
    .rejects.toThrow("$path must be a new directory outside the source backup");
  await mkdir(output());
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() })).rejects.toThrow("EEXIST");
});

test("中断后保留 incomplete.json、不生成 ready.json，换新目录重跑成功", async () => {
  await writeLegacyState({ copy: COPY });
  const before: readonly (MigrationFileSnapshot | null)[] = await sourceSnapshot();
  interruptReadyWrite = true;
  try {
    await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() })).rejects.toThrow("interrupted");
  } finally {
    interruptReadyWrite = false;
  }
  expect(await Bun.file(join(output(), "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output(), "incomplete.json")).exists()).toBeTrue();

  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() })).rejects.toThrow("EEXIST");
  const result: GlobalStateMigrationResult = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output("rerun") });
  expect(result.outputFiles.map((file): string => file.path)).toEqual(["memory/global/state.json"]);
  expect(await Bun.file(join(output("rerun"), "incomplete.json")).exists()).toBeFalse();
  expect(await sourceSnapshot()).toEqual(before);
});
