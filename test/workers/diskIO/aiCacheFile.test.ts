import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  aiCacheBuffer,
  aiCacheFileState,
  aiCacheReopenState,
  resetAiCacheState,
} from "../../../packages/cache/workers/diskIO/aiCache";
import {
  AI_CACHE_HIT_RATE_DIGITS,
  AI_CACHE_ROW_KEY_PATTERN,
  AI_CACHE_SUMMARY_KEY,
} from "../../../packages/consts/diskIO/aiCache";
import {
  DAY_FILE_JSON_INDENT,
  FLUSH_MAX_ENTRIES,
  LOG_REOPEN_RETRY_MS,
} from "../../../packages/consts/diskIO/appendOnly";
import { AI_CACHE_FILE_PATH, AI_CACHE_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../../packages/consts/paths";
import { TOKYO_UTC_OFFSET_MS } from "../../../packages/consts/time";
import { formatTokyoLogTimestamp } from "../../../packages/libs/time";
import {
  adoptAiCacheFile,
  flushAiCacheBuffer,
  handleAiCacheUsageMessage,
  inspectAiCacheFile,
  maintainAiCacheFile,
  summarizeAiCache,
} from "../../../packages/workers/diskIO/aiCacheFile";
import type { AiCacheUsageDiskMessage } from "../../../packages/types/diskIO/messages";
import type { AiTokenUsage } from "../../../packages/types/aiCache";

/** 东京某日中午的时间戳；只用于把记录归到指定东京日期。 */
function tokyoNoon(day: string): number {
  return Date.parse(`${day}T12:00:00Z`) - TOKYO_UTC_OFFSET_MS;
}

/** 按生产常量的小数位数算出期望命中率；分母为 0 时为 null。 */
function expectedHitRate(cachedInputTokens: number, reportedInputTokens: number): number | null {
  if (reportedInputTokens === 0) return null;
  const scale: number = 10 ** AI_CACHE_HIT_RATE_DIGITS;
  return Math.round(cachedInputTokens / reportedInputTokens * scale) / scale;
}

/** 记录键里的东京日期（第 1 组捕获）；不是记录键时为 undefined。 */
function rowKeyDay(key: string): string | undefined {
  return AI_CACHE_ROW_KEY_PATTERN.exec(key)?.[1];
}

function usage(
  day: string,
  overrides: Partial<Omit<AiTokenUsage, "kind">> = {}
): AiCacheUsageDiskMessage {
  return {
    type: "aiCacheUsage",
    kind: "tokens",
    timestamp: tokyoNoon(day),
    capability: "text",
    provider: "openai",
    model: "deepseek-flash",
    inputTokens: 1_000,
    cachedInputTokens: 800,
    outputTokens: 50,
    ...overrides,
  };
}

/** 一条只给费用的计量（xAI 生图）。 */
function costUsage(day: string, costInUsdTicks: number): AiCacheUsageDiskMessage {
  return {
    type: "aiCacheUsage",
    kind: "cost",
    timestamp: tokyoNoon(day),
    capability: "image",
    provider: "openai",
    model: "grok-image",
    costInUsdTicks,
  };
}

async function readDocument(): Promise<Record<string, unknown>> {
  return await Bun.file(AI_CACHE_FILE_PATH).json() as Record<string, unknown>;
}

async function initAiCache(): Promise<void> {
  adoptAiCacheFile(await inspectAiCacheFile());
}

beforeEach(() => {
  rmSync(AI_CACHE_MEMORY_DIR, { recursive: true, force: true });
  resetAiCacheState();
});

afterEach(() => {
  resetAiCacheState();
  rmSync(AI_CACHE_MEMORY_DIR, { recursive: true, force: true });
});

describe("diskIO/aiCacheFile 缓冲与追加", () => {
  test("记录先进内存缓冲，flush 后追加成合法 JSON，键带东京时间", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-26"));
    await handleAiCacheUsageMessage(usage("2026-09-26", { cachedInputTokens: null, provider: "google", model: "gemini" }));
    expect(aiCacheBuffer.texts).toHaveLength(2);
    expect(existsSync(AI_CACHE_FILE_PATH)).toBeFalse();

    expect(await flushAiCacheBuffer()).toBeTrue();
    const document: Record<string, unknown> = await readDocument();
    const keys: string[] = Object.keys(document);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(AI_CACHE_ROW_KEY_PATTERN);
    expect(keys[0]!.startsWith(`${formatTokyoLogTimestamp(tokyoNoon("2026-09-26"))}_`)).toBeTrue();
    expect(Object.values(document)).toEqual([
      { capability: "text", provider: "openai", model: "deepseek-flash", inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 },
      { capability: "text", provider: "google", model: "gemini", inputTokens: 1_000, cachedInputTokens: null, outputTokens: 50 },
    ]);

    await handleAiCacheUsageMessage(usage("2026-09-26"));
    expect(await flushAiCacheBuffer()).toBeTrue();
    expect(Object.keys(await readDocument())).toHaveLength(3);
  });

  test("缓冲达到 FLUSH_MAX_ENTRIES 时立即落盘并清掉定时器", async () => {
    await initAiCache();
    for (let index: number = 0; index < FLUSH_MAX_ENTRIES; index += 1) {
      await handleAiCacheUsageMessage(usage("2026-09-26"));
    }
    expect(aiCacheBuffer.texts).toHaveLength(0);
    expect(aiCacheBuffer.timer).toBeNull();
    expect(Object.keys(await readDocument())).toHaveLength(FLUSH_MAX_ENTRIES);
  });
});

describe("diskIO/aiCacheFile 追加失败与退避", () => {
  test("追加失败丢弃这一批并作废游标；退避窗口内的下一批不重新探测、同样丢弃；到点后重新探测并接着追加", async () => {
    const consoleError: Mock<typeof console.error> = spyOn(console, "error").mockImplementation((): void => {});
    const failedAt: number = tokyoNoon("2026-09-26");
    const modelsOnDisk = async (): Promise<unknown[]> =>
      Object.values(await readDocument()).map((row: unknown): unknown => (row as { model: unknown }).model);
    try {
      await initAiCache();
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "kept-before-failure" }));
      expect(await flushAiCacheBuffer()).toBeTrue();
      const healthyContent: string = await Bun.file(AI_CACHE_FILE_PATH).text();

      // 统计文件换成同名目录：下一次追加必然失败。
      rmSync(AI_CACHE_FILE_PATH);
      mkdirSync(AI_CACHE_FILE_PATH);
      setSystemTime(new Date(failedAt));
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "dropped-on-failure" }));
      expect(aiCacheBuffer.timer).not.toBeNull();

      expect(await flushAiCacheBuffer()).toBeFalse();
      expect(aiCacheBuffer.texts).toEqual([]);
      expect(aiCacheBuffer.timer).toBeNull();
      expect(aiCacheFileState.current).toBeNull();
      expect(aiCacheReopenState.retryAt).toBe(failedAt + LOG_REOPEN_RETRY_MS);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]).toEqual(["[diskIOWorker] AI cache usage flush failed:", expect.any(Error)]);

      // 文件已恢复可写，但仍在退避窗口内：不重新探测，这一批直接丢弃，也不再记错误。
      rmSync(AI_CACHE_FILE_PATH, { recursive: true });
      await Bun.write(AI_CACHE_FILE_PATH, healthyContent);
      setSystemTime(new Date(failedAt + LOG_REOPEN_RETRY_MS - 1));
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "dropped-in-backoff" }));

      expect(await flushAiCacheBuffer()).toBeFalse();
      expect(aiCacheBuffer.texts).toEqual([]);
      expect(aiCacheBuffer.timer).toBeNull();
      expect(aiCacheFileState.current).toBeNull();
      expect(aiCacheReopenState.retryAt).toBe(failedAt + LOG_REOPEN_RETRY_MS);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(healthyContent);

      // 退避到点：重新探测文件、接着已有记录追加，并清掉退避时刻。
      setSystemTime(new Date(failedAt + LOG_REOPEN_RETRY_MS));
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "appended-after-backoff" }));

      expect(await flushAiCacheBuffer()).toBeTrue();
      expect(aiCacheReopenState.retryAt).toBe(0);
      expect(aiCacheFileState.current?.size).toBe((await Bun.file(AI_CACHE_FILE_PATH).stat()).size);
      expect(await modelsOnDisk()).toEqual(["kept-before-failure", "appended-after-backoff"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      setSystemTime();
      consoleError.mockRestore();
    }
  });
});

describe("diskIO/aiCacheFile 每日汇总", () => {
  test("前一天的记录汇总到顶部并删除，当天记录保留，之后仍可继续追加", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-25"));
    await handleAiCacheUsageMessage(usage("2026-09-25", { inputTokens: 3_000, cachedInputTokens: 1_000, outputTokens: 70 }));
    await handleAiCacheUsageMessage(usage("2026-09-25", {
      capability: "ad_detect", model: "deepseek-flash", inputTokens: 500, cachedInputTokens: null, outputTokens: 5,
    }));
    await handleAiCacheUsageMessage(usage("2026-09-26", { inputTokens: 10, cachedInputTokens: 8 }));

    await summarizeAiCache("2026-09-26");

    const document: Record<string, unknown> = await readDocument();
    const keys: string[] = Object.keys(document);
    expect(keys[0]).toBe(AI_CACHE_SUMMARY_KEY);
    expect(keys).toHaveLength(2);
    expect(rowKeyDay(keys[1]!)).toBe("2026-09-26");
    expect(document[AI_CACHE_SUMMARY_KEY]).toEqual({
      day: "2026-09-25",
      requests: 3,
      inputTokens: 4_500,
      reportedInputTokens: 4_000,
      cachedInputTokens: 1_800,
      outputTokens: 125,
      cacheHitRate: expectedHitRate(1_800, 4_000),
      byModel: {
        "ad_detect/openai/deepseek-flash": {
          requests: 1, inputTokens: 500, reportedInputTokens: 0, cachedInputTokens: 0, outputTokens: 5, cacheHitRate: expectedHitRate(0, 0),
        },
        "text/openai/deepseek-flash": {
          requests: 2, inputTokens: 4_000, reportedInputTokens: 4_000, cachedInputTokens: 1_800, outputTokens: 120,
          cacheHitRate: expectedHitRate(1_800, 4_000),
        },
      },
    });

    await handleAiCacheUsageMessage(usage("2026-09-26"));
    expect(await flushAiCacheBuffer()).toBeTrue();
    expect(Object.keys(await readDocument())).toHaveLength(3);
    expect(aiCacheFileState.current?.size).toBe((await Bun.file(AI_CACHE_FILE_PATH).stat()).size);
  });

  test("费用记录只写费用字段，汇总与分组累加费用；只有 token 请求的分组不写费用键", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(costUsage("2026-09-25", 200_000_000));
    await handleAiCacheUsageMessage(costUsage("2026-09-25", 300_000_000));
    await handleAiCacheUsageMessage(usage("2026-09-25"));
    expect(await flushAiCacheBuffer()).toBeTrue();
    expect(Object.values(await readDocument())).toEqual([
      { capability: "image", provider: "openai", model: "grok-image", costInUsdTicks: 200_000_000 },
      { capability: "image", provider: "openai", model: "grok-image", costInUsdTicks: 300_000_000 },
      { capability: "text", provider: "openai", model: "deepseek-flash", inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 },
    ]);

    await summarizeAiCache("2026-09-26");
    const summary: Record<string, unknown> = (await readDocument())[AI_CACHE_SUMMARY_KEY] as Record<string, unknown>;
    expect(summary).toEqual({
      day: "2026-09-25",
      requests: 3,
      inputTokens: 1_000,
      reportedInputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 50,
      cacheHitRate: expectedHitRate(800, 1_000),
      costInUsdTicks: 500_000_000,
      byModel: {
        "image/openai/grok-image": {
          requests: 2, inputTokens: 0, reportedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          cacheHitRate: expectedHitRate(0, 0), costInUsdTicks: 500_000_000,
        },
        "text/openai/deepseek-flash": {
          requests: 1, inputTokens: 1_000, reportedInputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50,
          cacheHitRate: expectedHitRate(800, 1_000),
        },
      },
    });

    // 带费用的汇总被重新接管，同日再汇总时费用继续相加。
    resetAiCacheState();
    await initAiCache();
    await handleAiCacheUsageMessage(costUsage("2026-09-25", 1));
    await summarizeAiCache("2026-09-26");
    expect((await readDocument())[AI_CACHE_SUMMARY_KEY]).toMatchObject({ requests: 4, costInUsdTicks: 500_000_001 });
  });

  test("费用为 0 的请求仍算有过费用请求，汇总照写费用键", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(costUsage("2026-09-25", 0));
    await summarizeAiCache("2026-09-26");
    const summary: Record<string, unknown> = (await readDocument())[AI_CACHE_SUMMARY_KEY] as Record<string, unknown>;
    expect(summary).toMatchObject({ requests: 1, costInUsdTicks: 0 });
    expect((summary.byModel as Record<string, unknown>)["image/openai/grok-image"]).toMatchObject({ costInUsdTicks: 0 });
  });

  test("汇总只保留最近一天：更早的记录与旧汇总被替换，同日汇总相加", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-24"));
    await summarizeAiCache("2026-09-25");
    expect((await readDocument())[AI_CACHE_SUMMARY_KEY]).toMatchObject({ day: "2026-09-24", requests: 1 });

    // 汇总后又到达的同日记录（跨零点才落盘）与下一天一起处理：同日相加。
    await handleAiCacheUsageMessage(usage("2026-09-24"));
    await summarizeAiCache("2026-09-25");
    expect((await readDocument())[AI_CACHE_SUMMARY_KEY]).toMatchObject({ day: "2026-09-24", requests: 2, inputTokens: 2_000 });

    // 停机跨了几天：只保留最近一天的汇总，更早的记录与旧汇总都不保留。
    await handleAiCacheUsageMessage(usage("2026-09-26"));
    await handleAiCacheUsageMessage(usage("2026-09-27", { inputTokens: 7, cachedInputTokens: 7 }));
    await summarizeAiCache("2026-09-28");
    const document: Record<string, unknown> = await readDocument();
    expect(Object.keys(document)).toEqual([AI_CACHE_SUMMARY_KEY]);
    expect(document[AI_CACHE_SUMMARY_KEY]).toMatchObject({ day: "2026-09-27", requests: 1, inputTokens: 7 });
  });

  test("没有今天之前的记录时不重写文件", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-26"));
    await flushAiCacheBuffer();
    const before: number = (await Bun.file(AI_CACHE_FILE_PATH).stat()).mtimeMs;
    const content: string = await Bun.file(AI_CACHE_FILE_PATH).text();
    await Bun.sleep(5);
    await summarizeAiCache("2026-09-26");
    expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(content);
    expect((await Bun.file(AI_CACHE_FILE_PATH).stat()).mtimeMs).toBe(before);
  });

  test("启动维护清掉原子重写留下的临时文件并补做漏掉的汇总", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const orphan: string = join(AI_CACHE_MEMORY_DIR, `.${basename(AI_CACHE_FILE_PATH)}.123.abc${TMP_FILE_SUFFIX}`);
    await Bun.write(orphan, "partial");
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2000-01-01"));
    await flushAiCacheBuffer();

    await maintainAiCacheFile();

    expect(existsSync(orphan)).toBeFalse();
    expect((await readDocument())[AI_CACHE_SUMMARY_KEY]).toMatchObject({ day: "2000-01-01", requests: 1 });
    expect(readdirSync(AI_CACHE_MEMORY_DIR)).toEqual([basename(AI_CACHE_FILE_PATH)]);
  });
});

/** 严格解码用例共用的合法夹具；各用例只改其中一处。 */
const ROW_KEY: string = `${formatTokyoLogTimestamp(tokyoNoon("2026-09-26"))}_00000000-0000-4000-8000-000000000000`;
const ROW = { capability: "text", provider: "openai", model: "m", inputTokens: 10, cachedInputTokens: 4, outputTokens: 1 } as const;
const TOTALS = {
  requests: 1, inputTokens: 10, reportedInputTokens: 10, cachedInputTokens: 4, outputTokens: 1, cacheHitRate: expectedHitRate(4, 10),
  costInUsdTicks: undefined,
} as const;
const SUMMARY = { day: "2026-09-25", ...TOTALS, byModel: { "text/openai/m": TOTALS } } as const;

describe("diskIO/aiCacheFile 严格解码", () => {
  test("合法的汇总与记录被接管", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    await Bun.write(AI_CACHE_FILE_PATH, JSON.stringify({ [AI_CACHE_SUMMARY_KEY]: SUMMARY, [ROW_KEY]: ROW }, null, DAY_FILE_JSON_INDENT));
    const inspection = await inspectAiCacheFile();
    expect(inspection.document.summary).toEqual(SUMMARY);
    expect([...inspection.document.rows.keys()]).toEqual([ROW_KEY]);
  });

  test("撕裂的尾部被裁掉后接管，完整记录保留", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-26"));
    await flushAiCacheBuffer();
    const content: string = await Bun.file(AI_CACHE_FILE_PATH).text();
    const tornKey: string = `${formatTokyoLogTimestamp(tokyoNoon("2026-09-26") + 1_000)}_torn`;
    await Bun.write(AI_CACHE_FILE_PATH, `${content.slice(0, -2)},\n${" ".repeat(DAY_FILE_JSON_INDENT)}"${tornKey}`);
    resetAiCacheState();

    await initAiCache();

    expect(Object.keys(await readDocument())).toHaveLength(1);
  });

  test.each([
    ["未知键", { other: 1 }, "contains an unknown key other."],
    ["非法记录", { [ROW_KEY]: { capability: "text" } }, "contains an invalid usage record"],
    ["命中超过输入的记录", { [ROW_KEY]: { ...ROW, cachedInputTokens: 11 } }, "contains an invalid usage record"],
    ["记录多出字段", { [ROW_KEY]: { ...ROW, extra: 1 } }, "contains an invalid usage record"],
    ["费用记录费用为负", { [ROW_KEY]: { capability: "image", provider: "openai", model: "m", costInUsdTicks: -1 } }, "contains an invalid usage record"],
    ["记录同时带 token 与费用", { [ROW_KEY]: { ...ROW, costInUsdTicks: 1 } }, "contains an invalid usage record"],
    ["汇总费用非法", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, costInUsdTicks: 1.5 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["非法汇总日期", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, day: "2026-02-30" } }, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.day.`],
    ["汇总多出字段", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, extra: 1 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["命中率与合计不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cacheHitRate: expectedHitRate(9, 10) } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["命中超过有口径输入", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cachedInputTokens: 11, cacheHitRate: expectedHitRate(11, 10) } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["非法分组键", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, byModel: { "chat/openai/m": TOTALS } } }, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel key chat/openai/m.`],
    ["汇总不在首位", { [ROW_KEY]: ROW, [AI_CACHE_SUMMARY_KEY]: SUMMARY }, `must put ${AI_CACHE_SUMMARY_KEY} first.`],
  ])("%s 拒绝接管并保留原字节", async (_label: string, document: unknown, message: string) => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const content: string = JSON.stringify(document, null, DAY_FILE_JSON_INDENT);
    await Bun.write(AI_CACHE_FILE_PATH, content);
    await expect(inspectAiCacheFile()).rejects.toThrow(message);
    expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(content);
  });
});
