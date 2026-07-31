import { afterEach, describe, expect, test } from "bun:test";
import { flushBuffer, loggerFileState, markLogDirty, resetLogCache } from "../../../packages/cache/workers/diskIO/logs";
import {
  joinLogBuffer,
  joinLogCleanupDay,
  joinLogFileCaches,
  joinLogRetryAt,
  markJoinLogDirty,
  resetJoinLogCache,
} from "../../../packages/cache/workers/diskIO/joinLog";
import {
  hydrateLuckCache,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  markLuckDirty,
  resetLuckCache,
} from "../../../packages/cache/workers/diskIO/luck";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../../packages/cache/workers/diskIO/verification";

afterEach(() => {
  resetLogCache();
  resetLuckCache();
  resetVerificationPersistenceCache();
  resetJoinLogCache();
});

describe("Disk I/O append-domain cache owners", () => {
  test("日志 markDirty 与 reset 同时管理 buffer、文件游标和 timer", () => {
    expect(markLogDirty({ day: "2026-07-19", text: "entry" })).toBe(1);
    loggerFileState.current = { day: "2026-07-19", size: 10, empty: false };
    flushBuffer.timer = setTimeout(() => {}, 60_000);

    resetLogCache();

    expect(flushBuffer.entries).toHaveLength(0);
    expect(flushBuffer.timer).toBeNull();
    expect(loggerFileState.current).toBeNull();
  });

  test("运势 hydrate/reset 清掉旧 pending、文件游标和 timer", () => {
    hydrateLuckCache({ day: "2026-07-19", entries: new Map([["old", { label: "吉", fortunePercent: 80 }]]) });
    markLuckDirty({ key: "new", record: { label: "凶", fortunePercent: 20 } });
    luckFileState.current = { day: "2026-07-19", size: 10, empty: false };
    luckFlushTimer.timer = setTimeout(() => {}, 60_000);

    hydrateLuckCache({ day: "2026-07-20", entries: new Map() });

    expect(luckWorkerCache.current?.day).toBe("2026-07-20");
    expect(luckPendingAppends).toHaveLength(0);
    expect(luckFileState.current).toBeNull();
    expect(luckFlushTimer.timer).toBeNull();
  });

  test("待验证 reset 同时清理 active/pending、文件计数和两个 timer", () => {
    verificationWorkerCache.set("-1001:42", {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 1,
      phase: "pending",
      label: "pending",
      isBot: false,
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: false,
      joinedAt: 1,
      expiresAt: 2,
    });
    verificationPendingChanges.set("-1001:42", {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
      value: null,
    });
    verificationFileState.current = { day: "2026-07-19", size: 10, empty: false };
    verificationFileState.appendedEntries = 5;
    verificationFileState.appendedBytes = 100;
    verificationFlushTimer.timer = setTimeout(() => {}, 60_000);
    verificationRolloverTimer.timer = setTimeout(() => {}, 60_000);

    resetVerificationPersistenceCache();

    expect(verificationWorkerCache).toHaveLength(0);
    expect(verificationPendingChanges).toHaveLength(0);
    expect(verificationFileState).toEqual({ current: null, appendedEntries: 0, appendedBytes: 0 });
    expect(verificationFlushTimer.timer).toBeNull();
    expect(verificationRolloverTimer.timer).toBeNull();
  });

  test("入群日志 reset 同时清理缓冲、文件游标、退避与 timer", () => {
    expect(markJoinLogDirty({
      chatId: -1001,
      day: "2026-07-31",
      record: { userId: 42, joinedAt: 1 },
    })).toBe(1);
    joinLogFileCaches.set("-1001:2026-07-31", {
      state: { size: 10, empty: false },
      latestByUser: new Map([[42, { userId: 42, joinedAt: 1 }]]),
      snapshotBytes: 63,
      appendedBytesSinceCompaction: 0,
      redundantEntries: 0,
      capacityWarningEmitted: false,
    });
    joinLogRetryAt.set("-1001:2026-07-31", 99);
    joinLogCleanupDay.current = "2026-07-31";
    joinLogBuffer.timer = setTimeout((): void => {}, 60_000);

    resetJoinLogCache();

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(joinLogBuffer.timer).toBeNull();
    expect(joinLogFileCaches.size).toBe(0);
    expect(joinLogRetryAt.size).toBe(0);
    expect(joinLogCleanupDay.current).toBeNull();
  });
});
