import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  flushBuffer,
  loggerFileState,
  loggerReopenState,
  resetLogCache,
} from "../../../packages/cache/workers/diskIO/logs";
import { LOG_REOPEN_RETRY_MS } from "../../../packages/consts/diskIO/appendOnly";
import { LOGS_DIR, TMP_FILE_SUFFIX } from "../../../packages/consts/paths";
import { getDateKey } from "../../../packages/libs/time";
import {
  adoptLogFiles,
  flushLogBuffer,
  handleLogMessage,
  inspectLogFiles,
  maintainLogFiles,
  maintainLogRetention,
} from "../../../packages/workers/diskIO/logFiles";
import { serializeDayFileEntry } from "../../../packages/workers/diskIO/appendOnlyDayFile";
import type { LogEnvelope } from "../../../packages/types/diskIO/messages";

/**
 * 单领域恢复的测试编排：按生产 handleDiskIOStartupLoad 的顺序跑
 * inspect -> adopt -> maintenance（见 workers/diskIO/startup.ts），收成一个调用。
 */
async function initLogFiles(): Promise<void> {
  const inspection = await inspectLogFiles();
  adoptLogFiles(inspection);
  await maintainLogFiles(inspection);
}

beforeEach(() => {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  resetLogCache();
});

afterEach(() => {
  resetLogCache();
  rmSync(LOGS_DIR, { recursive: true, force: true });
});

describe("diskIO/logFiles 启动恢复", () => {
  test("成功初始化会接管当天文件并清理旧日志和孤儿临时文件", async () => {
    const today: string = getDateKey();
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const tempPath: string = join(LOGS_DIR, `orphan${TMP_FILE_SUFFIX}`);
    await Bun.write(stalePath, "{}");
    await Bun.write(tempPath, "partial");

    await initLogFiles();

    expect(loggerFileState.current?.day).toBe(today);
    expect(existsSync(stalePath)).toBeFalse();
    expect(existsSync(tempPath)).toBeFalse();
  });

  test("inspect 不规范化或清理，adopt 与 maintenance 分阶段生效", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const tempPath: string = join(LOGS_DIR, `orphan${TMP_FILE_SUFFIX}`);
    const original: string = '{"entry":{"level":"error","message":"boom"}}';
    await Bun.write(todayPath, original);
    await Bun.write(stalePath, "{}");
    await Bun.write(tempPath, "partial");

    const inspection = await inspectLogFiles();
    expect(await Bun.file(todayPath).text()).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(existsSync(tempPath)).toBeTrue();

    adoptLogFiles(inspection);
    expect((await Bun.file(todayPath).text()).endsWith("\n}")).toBeTrue();
    expect(existsSync(stalePath)).toBeTrue();
    expect(existsSync(tempPath)).toBeTrue();

    await maintainLogFiles(inspection);
    expect(existsSync(stalePath)).toBeFalse();
    expect(existsSync(tempPath)).toBeFalse();
  });

  test("当前日志文件结构不兼容时阻止接管并保留原文件及旧日日志", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const original: string = "[{\"bad\":\"shape\"}]";
    await Bun.write(todayPath, original);
    await Bun.write(stalePath, "{}");

    await expect(initLogFiles()).rejects.toThrow("must contain a top-level JSON object");
    expect(await Bun.file(todayPath).text()).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(loggerFileState.current).toBeNull();
  });

  test("当前日志记录 schema 不兼容时阻止接管且不规范化原文件", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const original: string = '{"entry":{"level":"error","message":42}}';
    await Bun.write(todayPath, original);
    await Bun.write(stalePath, "{}");

    await expect(initLogFiles()).rejects.toThrow("entry[0] must be a log record");
    expect(await Bun.file(todayPath).text()).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(loggerFileState.current).toBeNull();
  });

  test("非法日志条目的敏感键不进入异常", async () => {
    const today: string = getDateKey();
    const secret: string = "private-token-marker";
    await Bun.write(join(LOGS_DIR, `${today}.json`), JSON.stringify({ [secret]: { level: "error", message: 42 } }));
    const error: unknown = await inspectLogFiles().catch((caught: unknown): unknown => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("entry[0]");
    expect((error as Error).message).not.toContain(secret);
  });

  test("日志先进入内存批次，显式 flush 落盘并保留结构化参数", async () => {
    await initLogFiles();
    const timestamp: number = Date.UTC(2026, 6, 23, 12, 34, 56, 789);
    const day: string = getDateKey(timestamp);

    handleLogMessage({ type: "log", id: crypto.randomUUID(), timestamp, level: "error", args: ["request failed", { code: 503 }, "retrying"] });
    expect(flushBuffer.entries).toHaveLength(1);

    expect(await flushLogBuffer()).toBeTrue();
    expect(flushBuffer.entries).toHaveLength(0);
    const parsed = JSON.parse(await Bun.file(join(LOGS_DIR, `${day}.json`)).text()) as Record<string, {
      level: string;
      message: string;
      args?: unknown[];
    }>;
    const records = Object.values(parsed);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      level: "error",
      message: "request failed retrying",
      args: ["request failed", { code: 503 }, "retrying"],
    });
  });

  test("整批重投时同一条日志沿用主线程生成的 id，已写入的条目解析后仍只有一条", async () => {
    await initLogFiles();
    const timestamp: number = Date.UTC(2026, 6, 23, 23, 59, 59, 999);
    const day: string = getDateKey(timestamp);
    const envelope: LogEnvelope = { type: "log", id: crypto.randomUUID(), timestamp, level: "error", args: ["crossing midnight"] };

    handleLogMessage(envelope);
    expect(await flushLogBuffer()).toBeTrue();
    handleLogMessage(envelope);
    expect(await flushLogBuffer()).toBeTrue();

    const parsed = JSON.parse(await Bun.file(join(LOGS_DIR, `${day}.json`)).text()) as Record<string, object>;
    expect(Object.keys(parsed)).toHaveLength(1);
    expect(Object.keys(parsed)[0]!.endsWith(`_${envelope.id}`)).toBeTrue();
  });

  test("参数全是字符串时记录里不写 args 键", async () => {
    await initLogFiles();
    const timestamp: number = Date.UTC(2026, 6, 23, 12, 34, 56, 789);
    const day: string = getDateKey(timestamp);

    handleLogMessage({ type: "log", id: crypto.randomUUID(), timestamp, level: "info", args: ["bot", "started"] });
    expect(await flushLogBuffer()).toBeTrue();
    const parsed = JSON.parse(await Bun.file(join(LOGS_DIR, `${day}.json`)).text()) as Record<string, object>;
    const records = Object.values(parsed);
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!)).toEqual(["level", "message"]);
    expect(records[0]).toEqual({ level: "info", message: "bot started" });
  });

  test("每日维护先提交日志缓冲，再清理新出现的临时与过期文件", async () => {
    await initLogFiles();
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const tempPath: string = join(LOGS_DIR, `after-start${TMP_FILE_SUFFIX}`);
    await Bun.write(stalePath, "{}");
    await Bun.write(tempPath, "partial");
    const timestamp: number = Date.now();
    handleLogMessage({ type: "log", id: crypto.randomUUID(), timestamp, level: "error", args: ["daily maintenance"] });

    await maintainLogRetention();

    expect(flushBuffer.entries).toHaveLength(0);
    expect(existsSync(join(LOGS_DIR, `${getDateKey(timestamp)}.json`))).toBeTrue();
    expect(existsSync(stalePath)).toBeFalse();
    expect(existsSync(tempPath)).toBeFalse();
  });

  test("临时与过期文件删不掉时静默跳过，其余照删、维护不抛", async () => {
    await initLogFiles();
    const stuckTempPath: string = join(LOGS_DIR, `stuck${TMP_FILE_SUFFIX}`);
    const stuckStalePath: string = join(LOGS_DIR, "2000-01-02.json");
    const tempPath: string = join(LOGS_DIR, `other${TMP_FILE_SUFFIX}`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    // 目录形态的同名条目 unlink 必然 EISDIR，模拟权限等删除失败。
    mkdirSync(stuckTempPath);
    mkdirSync(stuckStalePath);
    await Bun.write(tempPath, "partial");
    await Bun.write(stalePath, "{}");

    await maintainLogRetention();

    expect(existsSync(stuckTempPath)).toBeTrue();
    expect(existsSync(stuckStalePath)).toBeTrue();
    expect(existsSync(tempPath)).toBeFalse();
    expect(existsSync(stalePath)).toBeFalse();
  });

  test("批次写入遇到不兼容文件时失败并重置游标，原文件保持不变", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const original: string = "[]";
    await Bun.write(todayPath, original);
    flushBuffer.entries.push({
      day: today,
      text: serializeDayFileEntry("entry", { level: "error", message: "boom" }),
    });

    expect(await flushLogBuffer()).toBeFalse();
    expect(flushBuffer.entries).toHaveLength(0);
    expect(loggerFileState.current).toBeNull();
    expect(await Bun.file(todayPath).text()).toBe(original);
  });

  test("追加失败后按退避间隔才重开日文件，而不是每次 flush 都整文件重读", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    await Bun.write(todayPath, "[]");
    flushBuffer.entries.push({ day: today, text: serializeDayFileEntry("a", { level: "error", message: "boom" }) });
    expect(await flushLogBuffer()).toBeFalse();
    expect(loggerReopenState.retryAt).toBeGreaterThan(0);

    // 文件此刻已经修好，但仍在退避窗口内：这一批照样丢弃，不去重开。
    await Bun.write(todayPath, "{}");
    flushBuffer.entries.push({ day: today, text: serializeDayFileEntry("b", { level: "error", message: "again" }) });
    expect(await flushLogBuffer()).toBeFalse();
    expect(await Bun.file(todayPath).text()).toBe("{}");

    // 退避到期后才重试；接管成功即清掉退避标记。
    loggerReopenState.retryAt = Date.now() - 1;
    flushBuffer.entries.push({ day: today, text: serializeDayFileEntry("c", { level: "error", message: "recovered" }) });
    expect(await flushLogBuffer()).toBeTrue();
    expect(loggerReopenState.retryAt).toBe(0);
    expect(Object.keys(JSON.parse(await Bun.file(todayPath).text()) as Record<string, unknown>)).toEqual(["c"]);
  });

  test("系统时钟回拨超过退避窗口时视为窗口已结束，下一批立即重开日文件", async () => {
    const today: string = getDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    await Bun.write(todayPath, "[]");
    flushBuffer.entries.push({ day: today, text: serializeDayFileEntry("a", { level: "error", message: "boom" }) });
    expect(await flushLogBuffer()).toBeFalse();
    const retryAt: number = loggerReopenState.retryAt;
    await Bun.write(todayPath, "{}");

    const clock = spyOn(Date, "now").mockReturnValue(retryAt - LOG_REOPEN_RETRY_MS - 1);
    try {
      flushBuffer.entries.push({ day: today, text: serializeDayFileEntry("b", { level: "error", message: "recovered" }) });
      expect(await flushLogBuffer()).toBeTrue();
    } finally {
      clock.mockRestore();
    }
    expect(loggerReopenState.retryAt).toBe(0);
    expect(Object.keys(JSON.parse(await Bun.file(todayPath).text()) as Record<string, unknown>)).toEqual(["b"]);
  });
});
