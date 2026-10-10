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
import { getTimeZone } from "../../../packages/config/time";
import { formatLogTimestamp } from "../../../packages/libs/time";
import {
  adoptAiCacheFile,
  flushAiCacheBuffer,
  handleAiCacheUsageMessage,
  inspectAiCacheFile,
  maintainAiCacheFile,
  summarizeAiCache,
} from "../../../packages/workers/diskIO/aiCacheFile";
import type { AiCacheUsageDiskMessage } from "../../../packages/types/diskIO/messages";
import type { AiCacheSummary, AiTokenUsage } from "../../../packages/types/aiCache";

/** 东京某日中午的时间戳；只用于把记录归到指定配置时区的日期。 */
function tokyoNoon(day: string): number {
  return Temporal.PlainDateTime.from(`${day}T12:00:00`).toZonedDateTime(getTimeZone()).epochMilliseconds;
}

/** 按生产常量的小数位数算出期望命中率；分母为 0 时为 null。 */
function expectedHitRate(cachedInputTokens: number, reportedInputTokens: number): number | null {
  if (reportedInputTokens === 0) return null;
  const scale: number = 10 ** AI_CACHE_HIT_RATE_DIGITS;
  return Math.round(cachedInputTokens / reportedInputTokens * scale) / scale;
}

/** 记录键里的配置时区的日期（第 1 组捕获）；不是记录键时为 undefined。 */
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

/** 一条没有有效 token 用量的联网检索次数记录。 */
function searchUsage(day: string, searchCalls: number): AiCacheUsageDiskMessage {
  return {
    type: "aiCacheUsage",
    kind: "search",
    timestamp: tokyoNoon(day),
    capability: "web_search",
    provider: "google",
    model: "gemini-search",
    searchCalls,
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
  test("记录先进内存缓冲，flush 后追加成合法 JSON，键带配置时区的时间", async () => {
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
    expect(keys[0]!.startsWith(`${formatLogTimestamp(tokyoNoon("2026-09-26"))}_`)).toBeTrue();
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

  test("系统时钟回拨超过退避窗口时视为窗口已结束，下一批立即重新探测并追加", async () => {
    const consoleError: Mock<typeof console.error> = spyOn(console, "error").mockImplementation((): void => {});
    const failedAt: number = tokyoNoon("2026-09-26");
    try {
      await initAiCache();
      rmSync(AI_CACHE_FILE_PATH, { force: true });
      mkdirSync(AI_CACHE_FILE_PATH);
      setSystemTime(new Date(failedAt));
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "dropped-on-failure" }));
      expect(await flushAiCacheBuffer()).toBeFalse();
      expect(aiCacheReopenState.retryAt).toBe(failedAt + LOG_REOPEN_RETRY_MS);

      rmSync(AI_CACHE_FILE_PATH, { recursive: true });
      setSystemTime(new Date(failedAt - 1));
      await handleAiCacheUsageMessage(usage("2026-09-26", { model: "appended-after-clock-step" }));

      expect(await flushAiCacheBuffer()).toBeTrue();
      expect(aiCacheReopenState.retryAt).toBe(0);
      expect(Object.values(await readDocument()).map((row: unknown): unknown => (row as { model: unknown }).model))
        .toEqual(["appended-after-clock-step"]);
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

  test("token 与检索次数同条落盘并恢复，汇总只计一次请求；缺 token 的检索只累加次数", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-25", { capability: "web_search", provider: "google", model: "gemini-search", searchCalls: 2 }));
    await handleAiCacheUsageMessage(usage("2026-09-25"));
    expect(await flushAiCacheBuffer()).toBeTrue();
    expect(Object.values(await readDocument())[0]).toEqual(
      { capability: "web_search", provider: "google", model: "gemini-search", inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50, searchCalls: 2 }
    );
    resetAiCacheState();
    await initAiCache();
    await summarizeAiCache("2026-09-26");
    const summary: Record<string, unknown> = (await readDocument())[AI_CACHE_SUMMARY_KEY] as Record<string, unknown>;
    expect(summary).toMatchObject({ requests: 2, inputTokens: 2_000, cachedInputTokens: 1_600, outputTokens: 100, searchCalls: 2 });
    expect(summary).not.toHaveProperty("costInUsdTicks");
    const byModel: Record<string, Record<string, unknown>> = summary.byModel as Record<string, Record<string, unknown>>;
    expect(byModel["web_search/google/gemini-search"]).toMatchObject({ requests: 1, searchCalls: 2 });
    expect(byModel["text/openai/deepseek-flash"]).not.toHaveProperty("searchCalls");

    // 同日的新响应与已有汇总合并；缺少缓存口径的输入不增加命中率分母。
    resetAiCacheState();
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-25", {
      capability: "web_search", provider: "google", model: "gemini-search",
      inputTokens: 400, cachedInputTokens: null, outputTokens: 10, searchCalls: 4,
    }));
    await handleAiCacheUsageMessage(searchUsage("2026-09-25", 1));
    await summarizeAiCache("2026-09-26");
    const merged: AiCacheSummary | null = (await inspectAiCacheFile()).document.summary;
    expect(merged).toMatchObject({
      requests: 3, inputTokens: 2_400, reportedInputTokens: 2_000, cachedInputTokens: 1_600,
      outputTokens: 110, searchCalls: 7, cacheHitRate: expectedHitRate(1_600, 2_000),
      byModel: {
        "web_search/google/gemini-search": {
          requests: 2, inputTokens: 1_400, reportedInputTokens: 1_000, cachedInputTokens: 800,
          outputTokens: 60, searchCalls: 7, cacheHitRate: expectedHitRate(800, 1_000),
        },
      },
    });
    await summarizeAiCache("2026-09-26");
    resetAiCacheState();
    await initAiCache();
    expect((await inspectAiCacheFile()).document.summary).toEqual(merged);
  });

  test("缓存写入随记录落盘并恢复；汇总与分组只累加给出写入的请求，从没给出过写入的分组不写该键", async () => {
    await initAiCache();
    const anthropic = { provider: "anthropic", model: "claude-test" } as const;
    await handleAiCacheUsageMessage(usage("2026-09-25", { ...anthropic, cacheWriteInputTokens: 150 }));
    await handleAiCacheUsageMessage(usage("2026-09-25", { ...anthropic, cachedInputTokens: null, cacheWriteInputTokens: 0 }));
    await handleAiCacheUsageMessage(usage("2026-09-25", anthropic));
    await handleAiCacheUsageMessage(usage("2026-09-25"));
    expect(await flushAiCacheBuffer()).toBeTrue();
    expect(Object.values(await readDocument())).toEqual([
      { capability: "text", ...anthropic, inputTokens: 1_000, cachedInputTokens: 800, cacheWriteInputTokens: 150, outputTokens: 50 },
      { capability: "text", ...anthropic, inputTokens: 1_000, cachedInputTokens: null, cacheWriteInputTokens: 0, outputTokens: 50 },
      { capability: "text", ...anthropic, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 },
      { capability: "text", provider: "openai", model: "deepseek-flash", inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 50 },
    ]);

    resetAiCacheState();
    await initAiCache();
    await summarizeAiCache("2026-09-26");
    const summary: Record<string, unknown> = (await readDocument())[AI_CACHE_SUMMARY_KEY] as Record<string, unknown>;
    expect(summary).toMatchObject({ requests: 4, inputTokens: 4_000, cachedInputTokens: 2_400, cacheWriteInputTokens: 150 });
    const byModel: Record<string, Record<string, unknown>> = summary.byModel as Record<string, Record<string, unknown>>;
    expect(byModel["text/anthropic/claude-test"]).toMatchObject({ requests: 3, inputTokens: 3_000, cacheWriteInputTokens: 150 });
    expect(byModel["text/openai/deepseek-flash"]).not.toHaveProperty("cacheWriteInputTokens");

    // 带写入的汇总被重新接管，同日再汇总时写入继续相加。
    resetAiCacheState();
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-25", { ...anthropic, cacheWriteInputTokens: 25 }));
    await summarizeAiCache("2026-09-26");
    expect((await inspectAiCacheFile()).document.summary).toMatchObject({
      cacheWriteInputTokens: 175,
      byModel: { "text/anthropic/claude-test": { requests: 4, cacheWriteInputTokens: 175 } },
    });
  });

  test("费用为 0 的请求仍算有过费用请求，汇总照写费用键", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(costUsage("2026-09-25", 0));
    await summarizeAiCache("2026-09-26");
    const summary: Record<string, unknown> = (await readDocument())[AI_CACHE_SUMMARY_KEY] as Record<string, unknown>;
    expect(summary).toMatchObject({ requests: 1, costInUsdTicks: 0 });
    expect((summary.byModel as Record<string, unknown>)["image/openai/grok-image"]).toMatchObject({ costInUsdTicks: 0 });
  });

  test.each(["inputTokens", "outputTokens", "costInUsdTicks", "searchCalls"] as const)(
    "汇总 %s 溢出时保留逐条记录和追加游标，不发布非法汇总",
    async (field: "inputTokens" | "outputTokens" | "costInUsdTicks" | "searchCalls") => {
      await initAiCache();
      const first: AiCacheUsageDiskMessage = field === "costInUsdTicks"
        ? costUsage("2026-09-25", Number.MAX_SAFE_INTEGER)
        : field === "searchCalls" ? searchUsage("2026-09-25", Number.MAX_SAFE_INTEGER)
          : usage("2026-09-25", { [field]: Number.MAX_SAFE_INTEGER, cachedInputTokens: null });
      const second: AiCacheUsageDiskMessage = { ...first, model: "another-model" };
      await handleAiCacheUsageMessage(first);
      await handleAiCacheUsageMessage(second);
      expect(await flushAiCacheBuffer()).toBeTrue();
      const content: string = await Bun.file(AI_CACHE_FILE_PATH).text();
      const size: number | undefined = aiCacheFileState.current?.size;
      await expect(summarizeAiCache("2026-09-26")).rejects.toThrow(`contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`);
      expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(content);
      expect(aiCacheFileState.current?.size).toBe(size);
      expect((await inspectAiCacheFile()).document.rows.size).toBe(2);
      await handleAiCacheUsageMessage(usage("2026-09-26"));
      expect(await flushAiCacheBuffer()).toBeTrue();
      expect((await inspectAiCacheFile()).document.rows.size).toBe(3);
    }
  );

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
const ROW_KEY: string = `${formatLogTimestamp(tokyoNoon("2026-09-26"))}_00000000-0000-4000-8000-000000000000`;
const ROW = { capability: "text", provider: "openai", model: "m", inputTokens: 10, cachedInputTokens: 4, outputTokens: 1 } as const;
const TOTALS = {
  requests: 1, inputTokens: 10, reportedInputTokens: 10, cachedInputTokens: 4, outputTokens: 1, cacheHitRate: expectedHitRate(4, 10),
  cacheWriteInputTokens: undefined, costInUsdTicks: undefined, searchCalls: undefined,
} as const;
const SUMMARY = { day: "2026-09-25", ...TOTALS, byModel: { "text/openai/m": TOTALS } } as const;

describe("diskIO/aiCacheFile 严格解码", () => {
  test("未知顶层键和分组键中的敏感文本不进入异常", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const secret: string = "private-token-marker";
    for (const document of [
      { [secret]: ROW },
      { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, byModel: { [secret]: TOTALS } } },
      { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, byModel: { [`text/openai/${secret}`]: { ...TOTALS, requests: -1 } } } },
    ]) {
      await Bun.write(AI_CACHE_FILE_PATH, JSON.stringify(document));
      const error: unknown = await inspectAiCacheFile().catch((caught: unknown): unknown => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });
  test.each(["2026-02-30 12:00:00.000", "2026-13-01 12:00:00.000", "2026-09-26 24:00:00.000", "2026-09-26 12:60:00.000", "2026-09-26 12:00:60.000"])(
    "非法配置时区的时间键 %s 拒绝接管并保留原字节",
    async (timestamp: string) => {
      mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
      const key: string = `${timestamp}_${ROW_KEY.slice(24)}`;
      const content: string = JSON.stringify({ [key]: ROW });
      await Bun.write(AI_CACHE_FILE_PATH, content);
      await expect(inspectAiCacheFile()).rejects.toThrow("entry[0] key must be");
      expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(content);
    }
  );

  test("写入恰为输入减命中的记录与合计被接管", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const totals = { ...TOTALS, cacheWriteInputTokens: 6 };
    const document = { [AI_CACHE_SUMMARY_KEY]: { ...totals, day: SUMMARY.day, byModel: { "text/anthropic/m": totals } }, [ROW_KEY]: { ...ROW, cacheWriteInputTokens: 6 } };
    await Bun.write(AI_CACHE_FILE_PATH, JSON.stringify(document, null, DAY_FILE_JSON_INDENT));
    const inspection = await inspectAiCacheFile();
    expect(inspection.document.rows.get(ROW_KEY)).toEqual({ ...ROW, cacheWriteInputTokens: 6 });
    expect(inspection.document.summary).toMatchObject({ cacheWriteInputTokens: 6, byModel: { "text/anthropic/m": { cacheWriteInputTokens: 6 } } });
  });

  test("anthropic 记录与分组键被接管", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const anthropicRow = { ...ROW, provider: "anthropic" };
    const summary = { ...SUMMARY, byModel: { "text/anthropic/m": TOTALS } };
    await Bun.write(AI_CACHE_FILE_PATH, JSON.stringify({ [AI_CACHE_SUMMARY_KEY]: summary, [ROW_KEY]: anthropicRow }, null, DAY_FILE_JSON_INDENT));
    const inspection = await inspectAiCacheFile();
    expect(inspection.document.rows.get(ROW_KEY) as unknown).toEqual(anthropicRow);
    expect(Object.keys(inspection.document.summary!.byModel)).toEqual(["text/anthropic/m"]);
  });

  test("合法的汇总与记录被接管", async () => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const paddedRow = { ...ROW, capability: ` ${ROW.capability} `, provider: ` ${ROW.provider} `, model: ` ${ROW.model} ` };
    await Bun.write(AI_CACHE_FILE_PATH, JSON.stringify({ [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, day: ` ${SUMMARY.day} ` }, [ROW_KEY]: paddedRow }, null, DAY_FILE_JSON_INDENT));
    const inspection = await inspectAiCacheFile();
    expect(inspection.document.summary).toEqual(SUMMARY);
    expect([...inspection.document.rows.keys()]).toEqual([ROW_KEY]);
    expect(inspection.document.rows.get(ROW_KEY)).toEqual(ROW);
  });

  test("撕裂的尾部被裁掉后接管，完整记录保留", async () => {
    await initAiCache();
    await handleAiCacheUsageMessage(usage("2026-09-26"));
    await flushAiCacheBuffer();
    const content: string = await Bun.file(AI_CACHE_FILE_PATH).text();
    const tornKey: string = `${formatLogTimestamp(tokyoNoon("2026-09-26") + 1_000)}_torn`;
    await Bun.write(AI_CACHE_FILE_PATH, `${content.slice(0, -2)},\n${" ".repeat(DAY_FILE_JSON_INDENT)}"${tornKey}`);
    resetAiCacheState();

    await initAiCache();

    expect(Object.keys(await readDocument())).toHaveLength(1);
  });

  test.each([
    ["未知键", { other: 1 }, "entry[0] key must be"],
    ["非法记录", { [ROW_KEY]: { capability: "text" } }, "contains an invalid usage record"],
    ["非对象记录", { [ROW_KEY]: null }, "expected a usage object"],
    ["命中超过输入的记录", { [ROW_KEY]: { ...ROW, cachedInputTokens: 11 } }, "contains an invalid usage record"],
    ["记录多出字段", { [ROW_KEY]: { ...ROW, extra: 1 } }, "contains an invalid usage record"],
    ["费用记录费用为负", { [ROW_KEY]: { capability: "image", provider: "openai", model: "m", costInUsdTicks: -1 } }, "contains an invalid usage record"],
    ["记录同时带 token 与费用", { [ROW_KEY]: { ...ROW, costInUsdTicks: 1 } }, "contains an invalid usage record"],
    ["未知 provider", { [ROW_KEY]: { ...ROW, provider: "claude" } }, "contains an invalid usage record"],
    ["空白模型名", { [ROW_KEY]: { ...ROW, model: "  " } }, "contains an invalid usage record"],
    ["检索次数为 0", { [ROW_KEY]: { capability: "web_search", provider: "google", model: "m", searchCalls: 0 } }, "contains an invalid usage record"],
    ["token 记录检索次数为 0", { [ROW_KEY]: { ...ROW, searchCalls: 0 } }, "contains an invalid usage record"],
    ["token 记录检索次数为小数", { [ROW_KEY]: { ...ROW, searchCalls: 0.5 } }, "contains an invalid usage record"],
    ["token 记录检索次数为 null", { [ROW_KEY]: { ...ROW, searchCalls: null } }, "contains an invalid usage record"],
    ["写入为负的记录", { [ROW_KEY]: { ...ROW, cacheWriteInputTokens: -1 } }, "contains an invalid usage record"],
    ["写入为 null 的记录", { [ROW_KEY]: { ...ROW, cacheWriteInputTokens: null } }, "contains an invalid usage record"],
    ["写入加命中超过输入的记录", { [ROW_KEY]: { ...ROW, cacheWriteInputTokens: 7 } }, "contains an invalid usage record"],
    ["没有命中口径时写入超过输入的记录", { [ROW_KEY]: { ...ROW, cachedInputTokens: null, cacheWriteInputTokens: 11 } }, "contains an invalid usage record"],
    ["费用记录带写入", { [ROW_KEY]: { capability: "image", provider: "openai", model: "m", costInUsdTicks: 1, cacheWriteInputTokens: 0 } }, "contains an invalid usage record"],
    ["汇总写入非法", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cacheWriteInputTokens: 0.5 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["汇总写入加命中超过输入", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cacheWriteInputTokens: 7, byModel: { "text/openai/m": { ...TOTALS, cacheWriteInputTokens: 7 } } } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.byModel[0].`],
    ["汇总检索次数非法", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, searchCalls: -1 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["汇总费用非法", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, costInUsdTicks: 1.5 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["非法汇总日期", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, day: "2026-02-30" } }, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.day.`],
    ["汇总多出字段", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, extra: 1 } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["命中率与合计不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cacheHitRate: expectedHitRate(9, 10) } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["命中超过有口径输入", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cachedInputTokens: 11, cacheHitRate: expectedHitRate(11, 10) } }, `contains invalid totals at ${AI_CACHE_SUMMARY_KEY}.`],
    ["非法分组键", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, byModel: { "chat/openai/m": TOTALS } } }, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel key at entry[0]`],
    ["空白分组模型名", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, byModel: { "text/openai/  ": TOTALS } } }, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel key`],
    ["非对象汇总", { [AI_CACHE_SUMMARY_KEY]: null }, "expected a summary object"],
    ["总请求数与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, requests: 2 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.requests.`],
    ["总输入与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, inputTokens: 11 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.inputTokens.`],
    ["总输出与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, outputTokens: 2 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.outputTokens.`],
    ["总检索次数与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, searchCalls: 1 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.searchCalls.`],
    ["总费用与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, costInUsdTicks: 1 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.costInUsdTicks.`],
    ["总写入与分组不符", { [AI_CACHE_SUMMARY_KEY]: { ...SUMMARY, cacheWriteInputTokens: 1 } }, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.cacheWriteInputTokens.`],
    ["汇总不在首位", { [ROW_KEY]: ROW, [AI_CACHE_SUMMARY_KEY]: SUMMARY }, `must put ${AI_CACHE_SUMMARY_KEY} first.`],
  ])("%s 拒绝接管并保留原字节", async (_label: string, document: unknown, message: string) => {
    mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
    const content: string = JSON.stringify(document, null, DAY_FILE_JSON_INDENT);
    await Bun.write(AI_CACHE_FILE_PATH, content);
    await expect(inspectAiCacheFile()).rejects.toThrow(message);
    expect(await Bun.file(AI_CACHE_FILE_PATH).text()).toBe(content);
  });
});
