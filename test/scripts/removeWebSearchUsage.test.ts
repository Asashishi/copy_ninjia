import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AI_CACHE_SUMMARY_KEY,
  AI_CACHE_USAGE_RELATIVE_PATH,
  AI_CACHE_USAGE_REMOVAL_FILE_MODE,
} from "../../packages/consts/diskIO/aiCache";
import { readJsonInput } from "../../packages/libs/inputValidation";
import type { AiCacheDocument, AiCacheRow, AiCacheSummary } from "../../packages/types/aiCache";
import { buildAiCacheSummary, decodeAiCacheDocument } from "../../packages/workers/diskIO/aiCacheDocument";
import { prepareWebSearchUsageRemoval } from "../../scripts/removeWebSearchUsage";
import type { WebSearchUsageRemovalResult } from "../../scripts/removeWebSearchUsage";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** 每个测试的独立停机备份和输出目录。 */
let root: string;
let source: string;
let sourcePath: string;

/** 当前格式的夹具键，日期由测试明确提供。 */
function rowKey(day: string, index: number): string {
  return `${day} 12:00:00.000_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** 同时含独立检索记录、合并记录和其他能力用量的停机快照。 */
function fixtureRows(): readonly AiCacheRow[] {
  return [
    { capability: "web_search", provider: "openai", model: "grok-4.7", inputTokens: 500, cachedInputTokens: 100, outputTokens: 30 },
    { capability: "web_search", provider: "openai", model: "grok-4.7", searchCalls: 8 },
    { capability: "web_search", provider: "google", model: "search-only", searchCalls: 1 },
    { capability: "text", provider: "anthropic", model: "text-search", inputTokens: 250, cachedInputTokens: null, outputTokens: 20, searchCalls: 3 },
    { capability: "image", provider: "openai", model: "grok-image", costInUsdTicks: 500_000_000 },
  ];
}

async function writeFixture(summary: AiCacheSummary | null = buildAiCacheSummary("2026-09-30", fixtureRows(), null)): Promise<void> {
  const document: Record<string, AiCacheSummary | AiCacheRow> = {};
  if (summary !== null) document[AI_CACHE_SUMMARY_KEY] = summary;
  const rows: readonly AiCacheRow[] = fixtureRows();
  for (let index: number = 0; index < rows.length; index++) document[rowKey("2026-10-01", index)] = rows[index]!;
  await Bun.write(sourcePath, JSON.stringify(document));
}

beforeEach(async (): Promise<void> => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "web-search-usage-removal-"));
  source = join(root, "source");
  sourcePath = join(source, AI_CACHE_USAGE_RELATIVE_PATH);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFixture();
});

afterEach(async (): Promise<void> => {
  await rm(root, { recursive: true, force: true });
});

test("删除全部 web_search 记录和汇总分组，重算总读数，保留其他能力及源字节", async (): Promise<void> => {
  const before: Uint8Array<ArrayBuffer> = await Bun.file(sourcePath).bytes();
  const result: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({ removedRows: 3, removedSummaryGroups: 2, keptRows: 2 });
  expect(result.summary).toMatchObject({
    day: "2026-09-30", requests: 2, inputTokens: 250, reportedInputTokens: 0, cachedInputTokens: 0,
    outputTokens: 20, cacheHitRate: null, searchCalls: 3, costInUsdTicks: 500_000_000,
  });
  expect(Object.keys(result.summary!.byModel)).toEqual(["image/openai/grok-image", "text/anthropic/text-search"]);
  const target: string = join(result.outputRoot, AI_CACHE_USAGE_RELATIVE_PATH);
  const document: AiCacheDocument = decodeAiCacheDocument(target, await readJsonInput(target));
  expect(document.summary).toEqual(result.summary);
  expect([...document.rows.keys()]).toEqual([rowKey("2026-10-01", 3), rowKey("2026-10-01", 4)]);
  const original: AiCacheDocument = decodeAiCacheDocument(sourcePath, await readJsonInput(sourcePath));
  for (const [key, row] of document.rows) expect(row).toEqual(original.rows.get(key)!);
  for (const [group, totals] of Object.entries(document.summary!.byModel)) expect(totals).toEqual(original.summary!.byModel[group]!);
  expect(result.outputFiles[0]?.mode).toBe(AI_CACHE_USAGE_REMOVAL_FILE_MODE);
  expect(result.sourceFiles[0]?.path).toBe(AI_CACHE_USAGE_RELATIVE_PATH);
  expect(result.sourceFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(typeof result.sourceFiles[0]?.uid).toBe("number");
  expect(typeof result.sourceFiles[0]?.gid).toBe("number");
  expect(typeof result.sourceFiles[0]?.mode).toBe("number");
  expect(await Bun.file(sourcePath).bytes()).toEqual(before);
  expect(JSON.stringify(await Bun.file(join(result.outputRoot, "ready.json")).json())).toBe(JSON.stringify(result));
  expect(await Bun.file(join(result.outputRoot, "incomplete.json")).exists()).toBeFalse();
});

test("无 summary 时保持缺省，合并的 web_search token 记录也被删除", async (): Promise<void> => {
  await writeFixture(null);
  await Bun.write(sourcePath, JSON.stringify({
    [rowKey("2026-10-01", 1)]: { capability: "web_search", provider: "anthropic", model: "m", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, searchCalls: 2 },
    [rowKey("2026-10-01", 2)]: fixtureRows()[3],
  }));
  const result: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result).toMatchObject({ removedRows: 1, removedSummaryGroups: 0, keptRows: 1, summary: null });
  expect(await Bun.file(join(result.outputRoot, AI_CACHE_USAGE_RELATIVE_PATH)).json()).not.toHaveProperty(AI_CACHE_SUMMARY_KEY);
});

test("只剩 web_search 分组时保留日期和空汇总，不生成费用或检索键", async (): Promise<void> => {
  await writeFixture(buildAiCacheSummary("2026-09-30", fixtureRows().slice(0, 3), null));
  const result: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result.summary).toMatchObject({ day: "2026-09-30", requests: 0, inputTokens: 0, reportedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheHitRate: null, byModel: {} });
  expect(result.summary?.searchCalls).toBeUndefined();
  expect(result.summary?.costInUsdTicks).toBeUndefined();
});

test("从已清理产物重新准备不重复扣除读数", async (): Promise<void> => {
  const first: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "first") });
  const second: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval({ sourceRoot: first.outputRoot, outputRoot: join(root, "second") });
  expect(second).toMatchObject({ removedRows: 0, removedSummaryGroups: 0, keptRows: 2 });
  expect(second.summary).toEqual(first.summary);
  expect(await Bun.file(join(second.outputRoot, AI_CACHE_USAGE_RELATIVE_PATH)).text()).toBe(await Bun.file(join(first.outputRoot, AI_CACHE_USAGE_RELATIVE_PATH)).text());
});

test.each(["syntax", "unknown", "count", "summary"])("非法来源 %s 保留源字节，不生成 ready", async (kind: string): Promise<void> => {
  const content: string = kind === "syntax" ? "{\"broken\":" : JSON.stringify(kind === "summary"
    ? { [AI_CACHE_SUMMARY_KEY]: { ...buildAiCacheSummary("2026-09-30", fixtureRows(), null), requests: 999 } }
    : { [rowKey("2026-10-01", 0)]: kind === "unknown" ? { extra: 1 }
      : { capability: "web_search", provider: "openai", model: "grok-4.7", searchCalls: -1 } });
  await Bun.write(sourcePath, content);
  await expect(prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow();
  expect(await Bun.file(sourcePath).text()).toBe(content);
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
});

test("不覆盖既有产物，输出不可位于源目录内，中断后向新目录重跑", async (): Promise<void> => {
  await mkdir(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "interrupted") })).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(source, "output") })).rejects.toThrow("outside the source backup");
  await expect(prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "retry") })).resolves.toMatchObject({ removedRows: 3 });
});

test("源目录链为符号链接时拒绝接管", async (): Promise<void> => {
  const alias: string = join(root, "alias");
  await mkdir(alias);
  symlinkSync(join(source, "memory"), join(alias, "memory"));
  await expect(prepareWebSearchUsageRemoval({ sourceRoot: alias, outputRoot: join(root, "output") })).rejects.toThrow("without symbolic links");
});

test("生成产物期间源备份改变时保留 incomplete，不生成 ready", async (): Promise<void> => {
  const write: typeof Bun.write = Bun.write;
  let changed: boolean = false;
  const mocked: Mock<typeof Bun.write> = spyOn(Bun, "write").mockImplementation(async (destination: any, input: any): Promise<number> => {
    const written: number = await write(destination, input);
    if (!changed) {
      changed = true;
      await write(sourcePath, `${await Bun.file(sourcePath).text()}\n`);
    }
    return written;
  });
  try {
    await expect(prepareWebSearchUsageRemoval({ sourceRoot: source, outputRoot: join(root, "output") })).rejects.toThrow("unchanged cold backup");
    expect(await Bun.file(join(root, "output/incomplete.json")).exists()).toBeTrue();
    expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  } finally {
    mocked.mockRestore();
  }
});

test.each([{ args: [] }, { args: ["--source-root", "missing"] }, { args: ["--unknown", "value"] }, { args: ["--help"] }])("CLI 参数明确校验或显示帮助：%j", async ({ args }: { readonly args: readonly string[] }): Promise<void> => {
  const process: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(["bun", join(import.meta.dir, "../../scripts/removeWebSearchUsage.ts"), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const exitCode: number = await process.exited;
  const output: string = await new Response(args[0] === "--help" ? process.stdout : process.stderr).text();
  expect(exitCode).toBe(args[0] === "--help" ? 0 : 1);
  expect(output).toContain(args[0] === "--help" ? "manually replace" : "arguments:");
});
