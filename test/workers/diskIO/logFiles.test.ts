import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  flushBuffer,
  loggerFileState,
  loggerReopenState,
  markLogDirty,
  resetLogCache,
} from "../../../packages/cache/workers/diskIO/logs";
import { LOGS_DIR, TMP_FILE_SUFFIX } from "../../../packages/consts/paths";
import { getTokyoDateKey } from "../../../packages/libs/time";
import {
  flushLogBuffer,
  handleLogMessage,
  initLogFiles,
} from "../../../packages/workers/diskIO/logFiles";
import { serializeDayFileEntry } from "../../../packages/workers/diskIO/appendOnlyDayFile";

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
  test("成功初始化会接管当天文件并清理旧日志和孤儿临时文件", () => {
    const today: string = getTokyoDateKey();
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const tempPath: string = join(LOGS_DIR, `orphan${TMP_FILE_SUFFIX}`);
    writeFileSync(stalePath, "{}");
    writeFileSync(tempPath, "partial");

    initLogFiles();

    expect(loggerFileState.current?.day).toBe(today);
    expect(existsSync(stalePath)).toBeFalse();
    expect(existsSync(tempPath)).toBeFalse();
  });

  test("当前日志文件结构不兼容时阻止接管并保留原文件及旧日日志", () => {
    const today: string = getTokyoDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const original: string = "[{\"bad\":\"shape\"}]";
    writeFileSync(todayPath, original);
    writeFileSync(stalePath, "{}");

    expect(() => initLogFiles()).toThrow("must contain a top-level JSON object");
    expect(readFileSync(todayPath, "utf8")).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(loggerFileState.current).toBeNull();
  });

  test("当前日志记录 schema 不兼容时阻止接管且不规范化原文件", () => {
    const today: string = getTokyoDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const stalePath: string = join(LOGS_DIR, "2000-01-01.json");
    const original: string = '{"entry":{"level":"error","message":42}}';
    writeFileSync(todayPath, original);
    writeFileSync(stalePath, "{}");

    expect(() => initLogFiles()).toThrow("contains an invalid log record for key entry");
    expect(readFileSync(todayPath, "utf8")).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(loggerFileState.current).toBeNull();
  });

  test("日志先进入内存批次，显式 flush 会取消 timer 并保留结构化参数", () => {
    initLogFiles();
    const timestamp: number = Date.UTC(2026, 6, 23, 12, 34, 56, 789);
    const day: string = getTokyoDateKey(new Date(timestamp));

    handleLogMessage({ timestamp, level: "error", args: ["request failed", { code: 503 }, "retrying"] });
    expect(flushBuffer.entries).toHaveLength(1);
    expect(flushBuffer.timer).not.toBeNull();

    expect(flushLogBuffer()).toBeTrue();
    expect(flushBuffer.entries).toHaveLength(0);
    expect(flushBuffer.timer).toBeNull();
    const parsed = JSON.parse(readFileSync(join(LOGS_DIR, `${day}.json`), "utf8")) as Record<string, {
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

  test("批次写入遇到不兼容文件时失败并重置游标，原文件保持不变", () => {
    const today: string = getTokyoDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    const original: string = "[]";
    writeFileSync(todayPath, original);
    markLogDirty({
      day: today,
      text: serializeDayFileEntry("entry", { level: "error", message: "boom" }),
    });

    expect(flushLogBuffer()).toBeFalse();
    expect(flushBuffer.entries).toHaveLength(0);
    expect(loggerFileState.current).toBeNull();
    expect(readFileSync(todayPath, "utf8")).toBe(original);
  });

  test("追加失败后按退避间隔才重开日文件，而不是每次 flush 都整文件重读", () => {
    // 重开一次要把整个日文件 readFileSync + JSON.parse 两遍、逐条走 schema 校验、
    // 再扫一遍目录，而磁盘满/卷转只读这类故障不会在一个 flush 周期内自愈。不退避
    // 的话每个周期都按日文件大小付一次这个代价，而这条线程同时持有 state.json、
    // 黑名单、移除 outbox 与 AI 记忆快照。
    const today: string = getTokyoDateKey();
    const todayPath: string = join(LOGS_DIR, `${today}.json`);
    writeFileSync(todayPath, "[]");
    markLogDirty({ day: today, text: serializeDayFileEntry("a", { level: "error", message: "boom" }) });
    expect(flushLogBuffer()).toBeFalse();
    expect(loggerReopenState.retryAt).toBeGreaterThan(0);

    // 文件此刻已经修好，但仍在退避窗口内：这一批照样丢弃，不去重开。
    writeFileSync(todayPath, "{}");
    markLogDirty({ day: today, text: serializeDayFileEntry("b", { level: "error", message: "again" }) });
    expect(flushLogBuffer()).toBeFalse();
    expect(readFileSync(todayPath, "utf8")).toBe("{}");

    // 退避到期后才重试；接管成功即清掉退避标记。
    loggerReopenState.retryAt = Date.now() - 1;
    markLogDirty({ day: today, text: serializeDayFileEntry("c", { level: "error", message: "recovered" }) });
    expect(flushLogBuffer()).toBeTrue();
    expect(loggerReopenState.retryAt).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(todayPath, "utf8")) as Record<string, unknown>)).toEqual(["c"]);
  });
});
