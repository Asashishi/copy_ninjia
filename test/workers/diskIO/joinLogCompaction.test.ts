import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { JoinLogFileCache } from "../../../packages/types/diskIO/storage";
import {
  snapshotRewriteFault,
  flushJoinLogBuffer,
  handleJoinLogMessage,
  joinLogBuffer,
  joinLogFileCaches,
  joinLogRetryAt,
  resetJoinLogCache,
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  getTokyoDateKey,
  joinMessage,
  currentFile,
  todayAt,
  writeRedundantJoinLogFile,
  expectFileMatchesCache,
} from "./joinLogFixture";

describe("入群日志压缩故障", () => {
  test("追加后压缩在 rename 前失败：本批照常报落盘、不退避，沿用 cache 并重新累计", async () => {
    const key: string = `-1001:${getTokyoDateKey()}`;
    const written: number =
      await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES * 2);
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 41, now));
    expect(await flushJoinLogBuffer()).toBeTrue();
    const cache: JoinLogFileCache = joinLogFileCaches.get(key)!;
    cache.redundantEntries = JOIN_LOG_COMPACT_REDUNDANT_ENTRIES;

    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      snapshotRewriteFault.current = "beforeRename";
      await handleJoinLogMessage(joinMessage(-1001, 42, now + 1));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(joinLogBuffer.entries).toHaveLength(0);
      expect(joinLogRetryAt.has(key)).toBeFalse();
      expect(joinLogFileCaches.get(key)).toBe(cache);
      expect(cache.redundantEntries).toBe(0);
      expect(cache.appendedBytesSinceCompaction).toBe(0);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain("failed to compact join log");
      const parsed = await expectFileMatchesCache(-1001);
      expect(parsed[`${now + 1}:42`]).toEqual({ userId: 42, joinedAt: now + 1 });
      expect(cache.state.size).toBeGreaterThan(written);

      // 沿用的游标仍指向同一个文件：下一批直接追加，文件保持合法；计数已清零，
      // 故障仍在也不会逐批重试整文件重写。
      const errorCalls: number = error.mock.calls.length;
      await handleJoinLogMessage(joinMessage(-1001, 43, now + 2));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(error.mock.calls.length).toBe(errorCalls);
      expect(joinLogFileCaches.get(key)).toBe(cache);
      expect((await expectFileMatchesCache(-1001))[`${now + 2}:43`])
        .toEqual({ userId: 43, joinedAt: now + 2 });
    } finally {
      error.mockRestore();
    }
  });

  test.each([false, true])("压缩时目录 fsync 失败：持续失败=%s，补齐同步前不能确认后续追加", async (persistent: boolean) => {
    const key: string = `-1001:${getTokyoDateKey()}`;
    await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES * 2);
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 41, now));
    expect(await flushJoinLogBuffer()).toBeTrue();
    joinLogFileCaches.get(key)!.redundantEntries = JOIN_LOG_COMPACT_REDUNDANT_ENTRIES;
    const realSync: typeof fs.fsyncSync = fs.fsyncSync;
    let attempts: number = 0;
    let fail: boolean = true;
    const error = spyOn(console, "error").mockImplementation((): void => {});
    const sync = spyOn(fs, "fsyncSync").mockImplementation((fd: number): void => {
      if (fs.fstatSync(fd).isDirectory()) {
        attempts++;
        if (fail && (persistent || attempts === 1)) {
          throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
        }
      }
      realSync(fd);
    });
    try {
      await handleJoinLogMessage(joinMessage(-1001, 42, now + 1));
      expect(await flushJoinLogBuffer()).toBe(!persistent);
      expect(attempts).toBe(2);
      expect(joinLogFileCaches.has(key)).toBeFalse();
      if (persistent) {
        joinLogRetryAt.clear();
        expect(await flushJoinLogBuffer()).toBeFalse();
        expect(attempts).toBe(3);
      }
      fail = false;
      joinLogRetryAt.clear();
      await handleJoinLogMessage(joinMessage(-1001, 43, now + 2));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(attempts).toBe(persistent ? 4 : 3);
      const parsed = await expectFileMatchesCache(-1001);
      expect(parsed[`${now + 1}:42`]).toEqual({ userId: 42, joinedAt: now + 1 });
      expect(parsed[`${now + 2}:43`]).toEqual({ userId: 43, joinedAt: now + 2 });
    } finally {
      sync.mockRestore();
      error.mockRestore();
    }
  });

  test("追加后压缩在 rename 后失败：本批照常报落盘、不退避，丢弃旧游标并按新快照重开", async () => {
    const key: string = `-1001:${getTokyoDateKey()}`;
    await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES * 2);
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 41, now));
    expect(await flushJoinLogBuffer()).toBeTrue();
    joinLogFileCaches.get(key)!.redundantEntries = JOIN_LOG_COMPACT_REDUNDANT_ENTRIES;

    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      snapshotRewriteFault.current = "afterRename";
      await handleJoinLogMessage(joinMessage(-1001, 42, now + 1));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(joinLogBuffer.entries).toHaveLength(0);
      expect(joinLogRetryAt.has(key)).toBeFalse();
      expect(joinLogFileCaches.has(key)).toBeFalse();
      expect(String(error.mock.calls.at(-1)?.[0])).toContain("failed to compact join log");
      const compacted: Record<string, { userId: number; joinedAt: number }> =
        JSON.parse(await Bun.file(currentFile(-1001)).text());
      expect(Object.keys(compacted)).toHaveLength(42);
      expect(compacted[`${now + 1}:42`]).toEqual({ userId: 42, joinedAt: now + 1 });

      snapshotRewriteFault.current = null;
      await handleJoinLogMessage(joinMessage(-1001, 43, now + 2));
      expect(await flushJoinLogBuffer()).toBeTrue();
      const parsed = await expectFileMatchesCache(-1001);
      expect(Object.keys(parsed)).toHaveLength(43);
      expect(parsed[`${now + 2}:43`]).toEqual({ userId: 43, joinedAt: now + 2 });
    } finally {
      error.mockRestore();
    }
  });

  test("接管时压缩失败不阻止接管：rename 前失败沿用原文件，rename 后失败按新快照再接管", async () => {
    const key: string = `-1001:${getTokyoDateKey()}`;
    const now: number = todayAt();
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      const written: number =
        await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_CHECK_BYTES + 64 * 1_024);
      snapshotRewriteFault.current = "beforeRename";
      await handleJoinLogMessage(joinMessage(-1001, 41, now));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(joinLogRetryAt.has(key)).toBeFalse();
      const kept: JoinLogFileCache = joinLogFileCaches.get(key)!;
      expect(kept.appendedBytesSinceCompaction).toBeLessThan(JOIN_LOG_COMPACT_CHECK_BYTES);
      expect(kept.state.size).toBeGreaterThan(written);
      expect((await expectFileMatchesCache(-1001))[`${now}:41`]).toEqual({ userId: 41, joinedAt: now });

      resetJoinLogCache();
      await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_CHECK_BYTES + 64 * 1_024);
      snapshotRewriteFault.current = "afterRename";
      await handleJoinLogMessage(joinMessage(-1001, 41, now));
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(joinLogRetryAt.has(key)).toBeFalse();
      const parsed = await expectFileMatchesCache(-1001);
      expect(Object.keys(parsed)).toHaveLength(41);
      expect(parsed[`${now}:41`]).toEqual({ userId: 41, joinedAt: now });
    } finally {
      error.mockRestore();
    }
  });

});
