import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalStateMigrationResult } from "../../scripts/migrateGlobalState";
import { readMigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import type { MigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import { TEST_DATA_ROOT } from "../preloadEnv";

// 写完成清单时注入中断，产物目录保留且源备份不变。
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
const STATE_PATH: string = "memory/global/state.json";
let root: string;
let source: string;
const COPY: Readonly<Record<string, unknown>> = {
  copiedUser: { id: 42, first_name: "复读目标" }, copyMode: "nya", copyChatId: -1001, lastCopyTime: 12,
};

function output(name: string = "output"): string {
  return join(root, name);
}

async function writeState(state: unknown = { copy: COPY, ttsUsage: { windowStartedAt: 1_000, count: 85 } }): Promise<void> {
  await Bun.write(join(source, STATE_PATH), JSON.stringify(state, null, 2));
}

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "global-state-migration-"));
  source = join(root, "data");
  await mkdir(join(source, "memory/global"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.each([0, 70, 85])("明确 AI 次数 %s 后拆分总数，保留起点与复读状态，源文件不变", async (agentCount: number) => {
  await writeState();
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(join(source, STATE_PATH));
  const result: GlobalStateMigrationResult = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount });
  expect(await Bun.file(join(output(), STATE_PATH)).json()).toEqual({
    copy: COPY, ttsUsage: { windowStartedAt: 1_000, agentCount, reserveCount: 85 - agentCount },
  });
  expect(result.sourceFiles.map((file): string => file.path)).toEqual([STATE_PATH]);
  expect(result.outputFiles.map((file): string => file.path)).toEqual([STATE_PATH]);
  expect(result.sourceFiles[0]?.sha256).toBe(before?.sha256);
  expect(result.outputFiles[0]?.sha256).toBe((await readMigrationFileSnapshot(join(output(), STATE_PATH)))?.sha256);
  expect(await Bun.file(join(output(), "ready.json")).json()).toEqual(JSON.parse(JSON.stringify(result)));
  expect(await readMigrationFileSnapshot(join(source, STATE_PATH))).toEqual(before);
});

test("没有 ttsUsage 时只保留 copy，不接受多余的次数参数", async () => {
  await writeState({ copy: COPY });
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount: 0 }))
    .rejects.toThrow("--agent-count must be absent when ttsUsage is absent");
  await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() });
  expect(await Bun.file(join(output(), STATE_PATH)).json()).toEqual({ copy: COPY });
});

test.each([undefined, -1, 1.5, 86, Number.MAX_SAFE_INTEGER + 1])("缺失或非法 AI 次数 %s 必须拒绝，不能猜测归属", async (agentCount: number | undefined) => {
  await writeState();
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount }))
    .rejects.toThrow("--agent-count must be an explicit non-negative safe integer not greater than ttsUsage.count");
  expect(await Bun.file(join(output(), "ready.json")).exists()).toBeFalse();
});

test("未知谱系与非法源状态一律拒绝，包括已拆分的计数与旧 global 包装", async () => {
  const cases: readonly [unknown, string][] = [
    [{ global: { copy: COPY } }, "$ must be a state document with copy and optional total-count ttsUsage"],
    [{ copy: COPY, assets: {} }, "$ must be a state document with copy and optional total-count ttsUsage"],
    [{ ttsUsage: { windowStartedAt: 1, count: 1 } }, "$ must be a state document with copy"],
    [{ copy: COPY, ttsUsage: { windowStartedAt: 1, agentCount: 1, reserveCount: 0 } }, "$.ttsUsage must be a total-count object"],
    [{ copy: COPY, ttsUsage: null }, "$.ttsUsage must be a total-count object"],
    [{ copy: COPY, ttsUsage: { windowStartedAt: -1, count: 1 } }, "$.ttsUsage.windowStartedAt must be a non-negative safe integer timestamp"],
    [{ copy: COPY, ttsUsage: { windowStartedAt: 1, count: 0 } }, "$.ttsUsage.count must be a positive safe integer"],
    [{ copy: COPY, ttsUsage: { windowStartedAt: 1, count: "1" } }, "$.ttsUsage.count must be a positive safe integer"],
    [{ copy: { copiedUser: null, copyMode: "nya" } }, "free of copyMode and copyChatId when copiedUser is null"],
  ];
  for (const [index, [document, message]] of cases.entries()) {
    await writeState(document);
    await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(`case-${index}`), agentCount: 0 }))
      .rejects.toThrow(message);
  }
});

test("源缺主文件或主文件是链接时拒绝；输出目录在源内或已存在时拒绝", async () => {
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() })).rejects.toThrow("state.json");
  await Bun.write(join(root, "elsewhere.json"), JSON.stringify({ copy: COPY }));
  symlinkSync(join(root, "elsewhere.json"), join(source, STATE_PATH));
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output() }))
    .rejects.toThrow("$type must be a regular file without symbolic links");
  await rm(join(source, STATE_PATH));
  await writeState();
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: join(source, "nested"), agentCount: 70 }))
    .rejects.toThrow("$path must be a new directory outside the source backup");
  await mkdir(output());
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount: 70 })).rejects.toThrow("EEXIST");
});

test("中断后保留 incomplete.json，不生成 ready.json，换新目录重跑成功", async () => {
  await writeState();
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(join(source, STATE_PATH));
  interruptReadyWrite = true;
  try {
    await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount: 70 })).rejects.toThrow("interrupted");
  } finally {
    interruptReadyWrite = false;
  }
  expect(await Bun.file(join(output(), "ready.json")).exists()).toBeFalse();
  expect(await Bun.file(join(output(), "incomplete.json")).exists()).toBeTrue();
  await expect(prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output(), agentCount: 70 })).rejects.toThrow("EEXIST");
  const result: GlobalStateMigrationResult = await prepareGlobalStateMigration({ sourceRoot: source, outputRoot: output("rerun"), agentCount: 70 });
  expect(result.outputFiles.map((file): string => file.path)).toEqual([STATE_PATH]);
  expect(await Bun.file(join(output("rerun"), "incomplete.json")).exists()).toBeFalse();
  expect(await readMigrationFileSnapshot(join(source, STATE_PATH))).toEqual(before);
});
