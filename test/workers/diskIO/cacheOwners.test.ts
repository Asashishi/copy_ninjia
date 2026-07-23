import { afterEach, describe, expect, test } from "bun:test";
import { flushBuffer, loggerFileState, markLogDirty, resetLogCache } from "../../../src/cache/diskIO/logs";
import {
  hydrateLuckCache,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  markLuckDirty,
  resetLuckCache,
} from "../../../src/cache/diskIO/luck";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../../src/cache/diskIO/verification";

afterEach(() => {
  resetLogCache();
  resetLuckCache();
  resetVerificationPersistenceCache();
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
      messageIds: [],
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
});
