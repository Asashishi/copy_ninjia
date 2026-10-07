import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JoinLogDiskMessage, ReadJoinLogRequest } from "../../../packages/types/diskIO/messages";
import type { JoinLogFileCache } from "../../../packages/types/diskIO/storage";
import { FLUSH_MAX_ENTRIES } from "../../../packages/consts/diskIO/appendOnly";
import { DAY_MS } from "../../../packages/consts/time";
import { JOIN_LOG_REOPEN_RETRY_MS } from "../../../packages/consts/diskIO/joinLog";
import { writeFileEntries } from "../../../packages/workers/diskIO/joinLogWrites";
import { adoptTimeZone, getTimeZone } from "../../../packages/config/time";
import {
  joinLogDir,
  UTF8_ENCODER,
  flushJoinLogBuffer,
  handleJoinLogDeleteMessage,
  handleJoinLogMessage,
  purgeJoinLogDeletions,
  inspectJoinLogFiles,
  maintainJoinLogFiles,
  maintainJoinLogRetention,
  readJoinLog,
  isRecentJoinLogDay,
  joinLogSnapshotChunks,
  measureJoinLogSnapshotBytes,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
  joinLogBuffer,
  joinLogDeletions,
  joinLogFileCaches,
  joinLogRetryAt,
  markJoinLogDirty,
  persistedReplies,
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_SNAPSHOT_CHUNK_BYTES,
  getDateKey,
  joinMessage,
  currentFile,
  datedFile,
  todayAt,
  todayMidnight,
  recoverJoinLogFiles,
  writeRedundantJoinLogFile,
} from "./joinLogFixture";

describe("diskIO/joinLogFiles", () => {
  test("模块加载本身不创建、不读取入群目录", () => {
    expect(existsSync(joinLogDir)).toBeFalse();
  });

  test("启动恢复会扫描保留窗口，坏状态阻止过期清理并保持原字节", async () => {
    const currentPath: string = currentFile(-1001);
    const stalePath: string = datedFile(-1001, "2000-01-01");
    const original: string = "{\"bad\":{\"userId\":42,\"joinedAt\":\"now\"}}";
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(currentPath, original);
    await Bun.write(stalePath, "{}");

    await expect(recoverJoinLogFiles()).rejects.toThrow("$.<record> must be exactly");
    expect(await Bun.file(currentPath).text()).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(joinLogFileCaches.size).toBe(0);
  });

  test("inspect 保留过期文件，maintenance 才执行清理", async () => {
    const stalePath: string = datedFile(-1001, "2000-01-01");
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(stalePath, "{}");

    const inspection = await inspectJoinLogFiles();
    expect(existsSync(stalePath)).toBeTrue();

    await maintainJoinLogFiles(inspection);
    expect(existsSync(stalePath)).toBeFalse();
  });

  test("启动恢复拒绝非法或未来文件名，不把它们当成可忽略资产", async () => {
    const invalidPath: string = join(joinLogDir, "bad.json");
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(invalidPath, "{}");

    await expect(recoverJoinLogFiles()).rejects.toThrow("canonical <chatId>.<YYYY-MM-DD>.json form");
    expect(await Bun.file(invalidPath).text()).toBe("{}");

    rmSync(invalidPath);
    const invalidDayPath: string = datedFile(-1001, "2026-02-30");
    await Bun.write(invalidDayPath, "{}");
    await expect(recoverJoinLogFiles()).rejects.toThrow("a canonical calendar date");
    expect(await Bun.file(invalidDayPath).text()).toBe("{}");

    rmSync(invalidDayPath);
    const futureDay: string = getDateKey(todayAt() + 2 * 24 * 60 * 60_000);
    const futurePath: string = datedFile(-1001, futureDay);
    await Bun.write(futurePath, "{}");
    await expect(recoverJoinLogFiles()).rejects.toThrow("a date no later than the current configured local day");
    expect(await Bun.file(futurePath).text()).toBe("{}");
  });

  test("启动恢复拒绝以正数私聊 ID 命名的入群日志", async () => {
    const path: string = currentFile(1001);
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(path, "{}");

    await expect(recoverJoinLogFiles()).rejects.toThrow("negative safe-integer Telegram group or channel ID");
    expect(await Bun.file(path).text()).toBe("{}");
  });

  test("入群先进入内存批次，flush 后按群追写当天 JSON 文件", async () => {
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 42, now));
    await handleJoinLogMessage(joinMessage(-1002, 43, now + 1));

    expect(joinLogBuffer.entries).toHaveLength(2);
    expect(joinLogBuffer.timer).not.toBeNull();
    expect(existsSync(currentFile(-1001))).toBeFalse();

    expect(await flushJoinLogBuffer()).toBeTrue();
    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(joinLogBuffer.timer).toBeNull();
    expect(JSON.parse(await Bun.file(currentFile(-1001)).text())).toEqual({
      [`${now}:42`]: { userId: 42, joinedAt: now },
    });
    expect(JSON.parse(await Bun.file(currentFile(-1002)).text())).toEqual({
      [`${now + 1}:43`]: { userId: 43, joinedAt: now + 1 },
    });
  });

  test("每日维护先提交缓冲，再按目标东京日清理过期文件", async () => {
    await recoverJoinLogFiles();
    const now: number = todayAt();
    const tomorrow: string = getDateKey(now + 24 * 60 * 60_000);
    const stalePath: string = datedFile(-1001, "2000-01-01");
    await Bun.write(stalePath, "{}");
    await handleJoinLogMessage(joinMessage(-1001, 42, now));

    await maintainJoinLogRetention(tomorrow);

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(existsSync(currentFile(-1001))).toBeTrue();
    expect(existsSync(stalePath)).toBeFalse();
  });

  test("临时与过期文件删不掉时静默跳过，保留其缓存，其余照删", async () => {
    await recoverJoinLogFiles();
    const tomorrow: string = getDateKey(todayAt() + 24 * 60 * 60_000);
    const stuckTempPath: string = join(joinLogDir, "stuck.json.tmp");
    const stuckStalePath: string = datedFile(-1001, "2000-01-02");
    const stalePath: string = datedFile(-1001, "2000-01-01");
    // 目录形态的同名条目 unlink 必然 EISDIR，模拟权限等删除失败。
    mkdirSync(stuckTempPath, { recursive: true });
    mkdirSync(stuckStalePath, { recursive: true });
    await Bun.write(stalePath, "{}");
    joinLogRetryAt.set("-1001:2000-01-02", 1);
    joinLogRetryAt.set("-1001:2000-01-01", 1);

    await maintainJoinLogRetention(tomorrow);

    expect(existsSync(stuckTempPath)).toBeTrue();
    expect(existsSync(stuckStalePath)).toBeTrue();
    expect(existsSync(stalePath)).toBeFalse();
    expect(joinLogRetryAt.has("-1001:2000-01-02")).toBeTrue();
    expect(joinLogRetryAt.has("-1001:2000-01-01")).toBeFalse();
    rmSync(stuckTempPath, { recursive: true, force: true });
    rmSync(stuckStalePath, { recursive: true, force: true });
  });

  test("命令读取前刷新缓冲、按时间过滤，并把同一用户折叠到最后一次加入", async () => {
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 42, now - 30_000));
    await handleJoinLogMessage(joinMessage(-1001, 42, now - 10_000));
    await handleJoinLogMessage(joinMessage(-1001, 43, now - 5_000));
    await handleJoinLogMessage(joinMessage(-1001, 44, now - 60_000));

    const records = await readJoinLog({
      type: "readJoinLog",
      requestId: 1,
      chatId: -1001,
      since: now - 20_000,
      now,
    });

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(records).toEqual([
      { userId: 42, joinedAt: now - 10_000 },
      { userId: 43, joinedAt: now - 5_000 },
    ]);
  });

  test("滚动窗口跨午夜合并两个自然日，并按用户保留最后一次加入", async () => {
    const midnight: number = todayMidnight();
    const beforeMidnight: number = midnight - 10 * 60_000;
    const afterMidnight: number = midnight + 5 * 60_000;
    const now: number = midnight + 10 * 60_000;
    await handleJoinLogMessage(joinMessage(-1001, 42, beforeMidnight));
    await handleJoinLogMessage(joinMessage(-1001, 43, beforeMidnight + 1));
    await handleJoinLogMessage(joinMessage(-1001, 42, afterMidnight));

    expect(await readJoinLog({
      type: "readJoinLog",
      requestId: 4,
      chatId: -1001,
      since: midnight - 15 * 60_000,
      now,
    })).toEqual([
      { userId: 43, joinedAt: beforeMidnight + 1 },
      { userId: 42, joinedAt: afterMidnight },
    ]);
    expect(existsSync(datedFile(
      -1001,
      getDateKey(beforeMidnight)
    ))).toBeTrue();
    expect(existsSync(currentFile(-1001))).toBeTrue();
  });

  test("夏令时短日的滚动窗口补记并读取三个日期，跨日排队后仍保留全部窗口文件", async (): Promise<void> => {
    const initialTimeZone: string = getTimeZone();
    adoptTimeZone("America/New_York");
    const now: number = Date.parse("2026-03-09T04:30:00Z");
    const since: number = now - DAY_MS;
    const middle: number = Date.parse("2026-03-08T16:00:00Z");
    const clock: Mock<() => number> = spyOn(Date, "now").mockReturnValue(now);
    try {
      await handleJoinLogMessage(joinMessage(-1001, 42, since));
      await handleJoinLogMessage(joinMessage(-1001, 43, middle));
      await handleJoinLogMessage(joinMessage(-1001, 44, now));
      expect(joinLogBuffer.entries).toHaveLength(3);
      expect(await flushJoinLogBuffer()).toBeTrue();
      const expected: readonly { userId: number; joinedAt: number }[] = [
        { userId: 42, joinedAt: since },
        { userId: 43, joinedAt: middle },
        { userId: 44, joinedAt: now },
      ];
      const request: ReadJoinLogRequest = { type: "readJoinLog", requestId: 1, chatId: -1001, since, now };
      expect(await readJoinLog(request)).toEqual(expected);
      clock.mockReturnValue(Date.parse("2026-03-10T04:00:00Z"));
      await maintainJoinLogRetention();
      expect(await readJoinLog(request)).toEqual(expected);
      expect(existsSync(datedFile(-1001, getDateKey(since)))).toBeTrue();
    } finally {
      clock.mockRestore();
      adoptTimeZone(initialTimeZone);
    }
  });

  test("首次写入或命令读取保留最近三个自然日并清理更旧日志与孤儿临时文件", async () => {
    const today: string = getDateKey();
    const twoDaysAgo: string =
      getDateKey(todayAt() - 2 * 24 * 60 * 60_000);
    mkdirSync(joinLogDir, { recursive: true });
    const stalePath: string = join(joinLogDir, "-1001.2000-01-01.json");
    const retainedPath: string =
      join(joinLogDir, `-1001.${twoDaysAgo}.json`);
    const currentOtherChatPath: string =
      join(joinLogDir, `-1002.${today}.json`);
    const tmpPath: string = join(joinLogDir, "orphan.json.tmp");
    const unrelatedPath: string = join(joinLogDir, "notes.txt");
    await Bun.write(stalePath, "{}");
    await Bun.write(retainedPath, "{}");
    await Bun.write(currentOtherChatPath, "{}");
    await Bun.write(tmpPath, "partial");
    await Bun.write(unrelatedPath, "keep");

    expect(await readJoinLog({
      type: "readJoinLog",
      requestId: 2,
      chatId: -1001,
      since: todayAt() - 60_000,
      now: todayAt(),
    })).toEqual([]);

    expect(existsSync(stalePath)).toBeFalse();
    expect(existsSync(retainedPath)).toBeTrue();
    expect(existsSync(tmpPath)).toBeFalse();
    expect(existsSync(currentOtherChatPath)).toBeTrue();
    expect(existsSync(unrelatedPath)).toBeTrue();
  });

  test("可解析但 schema 错误的当前日志拒绝读取并保留原字节", async () => {
    const path: string = currentFile(-1001);
    mkdirSync(joinLogDir, { recursive: true });
    const original: string = "{\"bad\":{\"userId\":42,\"joinedAt\":\"now\"}}";
    await Bun.write(path, original);

    await expect(readJoinLog({
      type: "readJoinLog",
      requestId: 3,
      chatId: -1001,
      since: todayAt() - 60_000,
      now: todayAt(),
    })).rejects.toThrow("$.<record> must be exactly");
    expect(await Bun.file(path).text()).toBe(original);
  });

  test("跨日重投的旧事件不重新创建历史文件，缓冲为空时立即发出处置回执", async () => {
    const staleAt: number = todayAt() - 3 * 24 * 60 * 60_000;
    await handleJoinLogMessage(joinMessage(-1001, 42, staleAt));

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(existsSync(joinLogDir)).toBeFalse();
    expect(persistedReplies).toEqual([{ type: "joinLogPersisted", through: 1, pending: [] }]);
  });

  test("领先本机今天的事件留在缓冲里等日期追上，不提前建文件，回执把它列为待写", async () => {
    const aheadAt: number = todayAt() + 2 * 24 * 60 * 60_000;
    await handleJoinLogMessage(joinMessage(-1001, 42, aheadAt));
    await handleJoinLogMessage(joinMessage(-1002, 43, todayAt()));

    expect(await flushJoinLogBuffer()).toBeFalse();
    expect(joinLogBuffer.entries).toEqual([{
      sequence: 1,
      chatId: -1001,
      day: getDateKey(aheadAt),
      record: { userId: 42, joinedAt: aheadAt },
    }]);
    expect(joinLogBuffer.timer).not.toBeNull();
    expect(existsSync(currentFile(-1002))).toBeTrue();
    expect(existsSync(datedFile(-1001, getDateKey(aheadAt)))).toBeFalse();
    // 序号 2 已落盘可释放，序号 1 仍在缓冲里，回执把它列为待写。
    expect(persistedReplies).toEqual([{ type: "joinLogPersisted", through: 2, pending: [1] }]);
  });

  test("同一事件重投不会增加物理文件字节", async () => {
    const now: number = todayAt();
    const message: JoinLogDiskMessage = joinMessage(-1001, 42, now);
    await handleJoinLogMessage(message);
    expect(await flushJoinLogBuffer()).toBeTrue();
    const firstContent: string = await Bun.file(currentFile(-1001)).text();

    await handleJoinLogMessage(message);
    expect(await flushJoinLogBuffer()).toBeTrue();

    expect(await Bun.file(currentFile(-1001)).text()).toBe(firstContent);
    const cache: JoinLogFileCache | undefined =
      joinLogFileCaches.get(`-1001:${getDateKey()}`);
    expect(cache).toBeDefined();
    if (cache === undefined) throw new Error("Join log cache was not built.");
    expect(cache.snapshotBytes).toBe(
      measureJoinLogSnapshotBytes(cache.latestByUser)
    );
  });

  test("一万次精确重投仍只保留一条物理与逻辑记录", async () => {
    const now: number = todayAt();
    const message: JoinLogDiskMessage = joinMessage(-1001, 42, now);
    for (let index: number = 0; index < 10_000; index += 1) {
      await handleJoinLogMessage(message);
    }
    expect(await flushJoinLogBuffer()).toBeTrue();

    const content: string = await Bun.file(currentFile(-1001)).text();
    expect(JSON.parse(content)).toEqual({
      [`${now}:42`]: { userId: 42, joinedAt: now },
    });
    expect(content.match(new RegExp(`"${now}:42"`, "g"))).toHaveLength(1);
  });

  test("载入超过评估门槛的历史文件时当场压实，只留每人最后一次入群", async () => {
    const written: number =
      await writeRedundantJoinLogFile(-1001, 40, JOIN_LOG_COMPACT_CHECK_BYTES + 64 * 1_024);
    expect(written).toBeGreaterThanOrEqual(JOIN_LOG_COMPACT_CHECK_BYTES);

    // 压实挂在「第一次真正打开这份文件」上，不在启动扫描里；按需读取就是那一刻。
    expect(await readJoinLog({
      type: "readJoinLog",
      requestId: 1,
      chatId: -1001,
      since: todayMidnight(),
      now: todayMidnight() + 12 * 60 * 60_000,
    })).toHaveLength(40);

    const content: string = await Bun.file(currentFile(-1001)).text();
    const parsed: Record<string, { userId: number; joinedAt: number }> = JSON.parse(content);
    expect(Object.keys(parsed)).toHaveLength(40);
    expect(UTF8_ENCODER.encode(content).byteLength)
      .toBeLessThan(written - JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES);
    // 压实后计数归零，下一段增量重新累计。
    const cache: JoinLogFileCache | undefined =
      joinLogFileCaches.get(`-1001:${getDateKey()}`);
    expect(cache?.appendedBytesSinceCompaction).toBe(0);
    expect(cache?.redundantEntries).toBe(0);
    expect(cache?.state.size).toBe(UTF8_ENCODER.encode(content).byteLength);
  });

  test("冗余条数够了但收不回空间时不重写，只重新开始累计", async () => {
    const now: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 1, now));
    expect(await flushJoinLogBuffer()).toBeTrue();
    const before: string = await Bun.file(currentFile(-1001)).text();

    const cache: JoinLogFileCache | undefined =
      joinLogFileCaches.get(`-1001:${getDateKey()}`);
    expect(cache).toBeDefined();
    cache!.redundantEntries = JOIN_LOG_COMPACT_REDUNDANT_ENTRIES;
    cache!.appendedBytesSinceCompaction = JOIN_LOG_COMPACT_CHECK_BYTES;

    await handleJoinLogMessage(joinMessage(-1001, 2, now + 1));
    expect(await flushJoinLogBuffer()).toBeTrue();

    const after: string = await Bun.file(currentFile(-1001)).text();
    expect(after.startsWith(before.slice(0, before.length - 2))).toBeTrue();
    expect(cache!.redundantEntries).toBe(0);
    expect(cache!.appendedBytesSinceCompaction).toBe(0);
  });

  test("写失败时保留原批次并退避，文件恢复后可再次 flush", async () => {
    const now: number = todayAt();
    const path: string = currentFile(-1001);
    mkdirSync(path, { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      await handleJoinLogMessage(joinMessage(-1001, 42, now));

      expect(await flushJoinLogBuffer()).toBeFalse();
      expect(joinLogBuffer.entries).toEqual([{
        sequence: 1,
        chatId: -1001,
        day: getDateKey(),
        record: { userId: 42, joinedAt: now },
      }]);
      expect(joinLogBuffer.timer).not.toBeNull();
      expect(persistedReplies).toEqual([{ type: "joinLogPersisted", through: 1, pending: [1] }]);

      rmSync(path, { recursive: true, force: true });
      joinLogRetryAt.clear();
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(joinLogBuffer.entries).toHaveLength(0);
      expect(persistedReplies).toEqual([
        { type: "joinLogPersisted", through: 1, pending: [1] },
        { type: "joinLogPersisted", through: 1, pending: [] },
      ]);
      expect(JSON.parse(await Bun.file(path).text())).toEqual({
        [`${now}:42`]: { userId: 42, joinedAt: now },
      });
    } finally {
      error.mockRestore();
    }
  });

  test("系统时钟回拨超过退避窗口时视为窗口已结束，同一文件立即重试", async () => {
    const now: number = todayAt();
    const day: string = getDateKey();
    const path: string = currentFile(-1001);
    mkdirSync(path, { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const entry = { sequence: 1, chatId: -1001, day, record: { userId: 42, joinedAt: now } };
      expect(await writeFileEntries(-1001, day, [entry])).toBeFalse();
      expect(joinLogRetryAt.get(`-1001:${day}`)).toBe(now + JOIN_LOG_REOPEN_RETRY_MS);

      rmSync(path, { recursive: true, force: true });
      clock.mockReturnValue(now - 1);
      expect(await writeFileEntries(-1001, day, [entry])).toBeTrue();
      expect(joinLogRetryAt.get(`-1001:${day}`)).toBeUndefined();
      expect(JSON.parse(await Bun.file(path).text())).toEqual({
        [`${now}:42`]: { userId: 42, joinedAt: now },
      });
    } finally {
      clock.mockRestore();
      error.mockRestore();
    }
  });

  test("入群日志目录建不出来时整批留在缓冲里退避，不抛出也不算已处置", async () => {
    rmSync(joinLogDir, { recursive: true, force: true });
    await Bun.write(joinLogDir, "not a directory");
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      for (let index: number = 0; index < FLUSH_MAX_ENTRIES; index += 1) {
        await handleJoinLogMessage(joinMessage(-1001, index + 1, todayAt(index)));
      }

      expect(joinLogBuffer.entries).toHaveLength(FLUSH_MAX_ENTRIES);
      expect(persistedReplies.at(-1)?.pending).toHaveLength(FLUSH_MAX_ENTRIES);
    } finally {
      error.mockRestore();
      rmSync(joinLogDir, { force: true });
    }
  });

  test("容量降级只保留 joinedAt 最新的成员记录", () => {
    const records: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>([
        [1, { userId: 1, joinedAt: 100 }],
        [2, { userId: 2, joinedAt: 300 }],
        [3, { userId: 3, joinedAt: 200 }],
      ]);

    expect(trimJoinLogRecordsToCapacity(records, 2)).toBe(1);
    expect([...records.keys()].sort()).toEqual([2, 3]);
  });

  test("容量裁剪在乱序与同时间戳下仍使用 userId 稳定决胜", () => {
    const records: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>([
        [6, { userId: 6, joinedAt: 30 }],
        [1, { userId: 1, joinedAt: 10 }],
        [5, { userId: 5, joinedAt: 5 }],
        [4, { userId: 4, joinedAt: 20 }],
        [3, { userId: 3, joinedAt: 5 }],
        [2, { userId: 2, joinedAt: 10 }],
      ]);

    expect(trimJoinLogRecordsToCapacity(records, 3)).toBe(3);
    expect([...records.keys()].sort()).toEqual([2, 4, 6]);
    expect(() => trimJoinLogRecordsToCapacity(records, 0)).toThrow(
      "positive safe integer"
    );
  });

  test("高基数容量裁剪只淘汰溢出的最旧 300 人", () => {
    const records: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>();
    for (let userId: number = 1; userId <= 20_000; userId += 1) {
      records.set(userId, { userId, joinedAt: userId });
    }

    expect(trimJoinLogRecordsToCapacity(records, 19_700)).toBe(300);
    expect(records).toHaveLength(19_700);
    expect(records.has(300)).toBeFalse();
    expect(records.get(301)).toEqual({ userId: 301, joinedAt: 301 });
    expect(records.get(20_000)).toEqual({
      userId: 20_000,
      joinedAt: 20_000,
    });
  });

  test("一万条快照按硬顶分块且字节测量与 JSON 语义一致", () => {
    const records: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>();
    for (let userId: number = 1; userId <= 10_000; userId += 1) {
      records.set(userId, { userId, joinedAt: 1_000_000 + userId });
    }
    const chunks: string[] = [...joinLogSnapshotChunks(records)];
    const content: string = chunks.join("");

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(UTF8_ENCODER.encode(chunk).byteLength).toBeLessThanOrEqual(
        JOIN_LOG_SNAPSHOT_CHUNK_BYTES + 2
      );
    }
    expect(UTF8_ENCODER.encode(content).byteLength).toBe(
      measureJoinLogSnapshotBytes(records)
    );
    const parsed: Record<string, { userId: number; joinedAt: number }> =
      JSON.parse(content);
    expect(Object.keys(parsed)).toHaveLength(records.size);
    expect(parsed["1000001:1"]).toEqual({ userId: 1, joinedAt: 1_000_001 });
    expect(parsed["1010000:10000"]).toEqual({
      userId: 10_000,
      joinedAt: 1_010_000,
    });
  });

  test("空快照与单条专用序列化保持标准 JSON 格式", () => {
    const empty: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>();
    expect([...joinLogSnapshotChunks(empty)]).toEqual(["{}"]);
    expect(measureJoinLogSnapshotBytes(empty)).toBe(2);
    expect(serializeJoinLogSnapshotEntry({
      userId: 42,
      joinedAt: 1_800_000_000_042,
    })).toBe(
      "  \"1800000000042:42\": {\n" +
      "    \"userId\": 42,\n" +
      "    \"joinedAt\": 1800000000042\n" +
      "  }"
    );
  });

  test("群日索引使用 LRU 并始终受硬顶约束", async () => {
    const now: number = todayAt();
    const day: string = getDateKey();
    mkdirSync(joinLogDir, { recursive: true });
    for (
      let index: number = 0;
      index <= JOIN_LOG_MAX_CACHED_FILES;
      index += 1
    ) {
      await Bun.write(datedFile(-10_000 - index, day), "{}");
    }
    const readEmpty: (chatId: number) => Promise<void> = async (chatId: number): Promise<void> => {
      expect(await readJoinLog({
        type: "readJoinLog",
        requestId: Math.abs(chatId),
        chatId,
        since: now - 60_000,
        now,
      })).toEqual([]);
    };
    for (let index: number = 0; index < JOIN_LOG_MAX_CACHED_FILES; index += 1) {
      await readEmpty(-10_000 - index);
    }
    await readEmpty(-10_000);
    await readEmpty(-10_000 - JOIN_LOG_MAX_CACHED_FILES);

    expect(joinLogFileCaches.size).toBe(JOIN_LOG_MAX_CACHED_FILES);
    expect(joinLogFileCaches.has(`-10000:${day}`)).toBeTrue();
    expect(joinLogFileCaches.has(`-10001:${day}`)).toBeFalse();
  });

  test("回归：一个群写不动时，其它群的按需读取照常成功", async () => {
    const now: number = todayAt();
    // 群 A 的当天文件被目录占位，写入必然失败并留在缓冲里退避。
    const brokenPath: string = currentFile(-1001);
    mkdirSync(brokenPath, { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      await handleJoinLogMessage(joinMessage(-1001, 42, now - 10_000));
      await handleJoinLogMessage(joinMessage(-2002, 77, now - 10_000));

      // 群 B 的日志不受群 A 写失败影响。
      expect(await readJoinLog({
        type: "readJoinLog",
        requestId: 9,
        chatId: -2002,
        since: now - 20_000,
        now,
      })).toEqual([{ userId: 77, joinedAt: now - 10_000 }]);

      // 群 A 自己的读取如实报错，并点名是哪个群哪一天。
      await expect(readJoinLog({
        type: "readJoinLog",
        requestId: 10,
        chatId: -1001,
        since: now - 20_000,
        now,
      })).rejects.toThrow(`Failed to flush pending join logs for chat -1001 on ${getDateKey()} before reading.`);
    } finally {
      error.mockRestore();
      rmSync(brokenPath, { recursive: true, force: true });
    }
  });

  test("失败退避表受独立硬顶约束，淘汰不丢待刷事实", async () => {
    const now: number = todayAt();
    mkdirSync(joinLogDir, { recursive: true });
    for (
      let index: number = 0;
      index <= JOIN_LOG_MAX_RETRY_FILES;
      index += 1
    ) {
      const chatId: number = -20_000 - index;
      mkdirSync(currentFile(chatId));
      await handleJoinLogMessage(joinMessage(chatId, index + 1, now + index));
    }
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      expect(await flushJoinLogBuffer()).toBeFalse();
    } finally {
      error.mockRestore();
    }

    expect(joinLogRetryAt.size).toBe(JOIN_LOG_MAX_RETRY_FILES);
    expect(joinLogBuffer.entries).toHaveLength(
      JOIN_LOG_MAX_RETRY_FILES + 1
    );
  });

  test("累计 FLUSH_MAX_ENTRIES 条立即刷出，回执随之覆盖到最后一条", async () => {
    const now: number = todayAt();
    for (let index: number = 0; index < FLUSH_MAX_ENTRIES - 1; index += 1) {
      await handleJoinLogMessage(joinMessage(-1001, index + 1, now + index));
    }
    expect(joinLogBuffer.entries).toHaveLength(FLUSH_MAX_ENTRIES - 1);
    expect(existsSync(currentFile(-1001))).toBeFalse();
    expect(persistedReplies).toEqual([]);

    await handleJoinLogMessage(joinMessage(-1001, FLUSH_MAX_ENTRIES, now + FLUSH_MAX_ENTRIES));

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(joinLogBuffer.timer).toBeNull();
    expect(Object.keys(JSON.parse(await Bun.file(currentFile(-1001)).text())))
      .toHaveLength(FLUSH_MAX_ENTRIES);
    expect(persistedReplies).toEqual([{ type: "joinLogPersisted", through: FLUSH_MAX_ENTRIES, pending: [] }]);
  });

  test("一个群写失败时只有它的事实留作待写，其它群照常落盘并可释放", async () => {
    const now: number = todayAt();
    mkdirSync(currentFile(-1001), { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      await handleJoinLogMessage(joinMessage(-1002, 41, now));
      await handleJoinLogMessage(joinMessage(-1001, 42, now + 1));
      await handleJoinLogMessage(joinMessage(-1002, 43, now + 2));

      expect(await flushJoinLogBuffer()).toBeFalse();
      expect(joinLogBuffer.entries.map((entry): number => entry.sequence)).toEqual([2]);
      expect(persistedReplies).toEqual([{ type: "joinLogPersisted", through: 3, pending: [2] }]);

      // 条件未变的重试不重发回执。
      expect(await flushJoinLogBuffer()).toBeFalse();
      expect(persistedReplies).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("单日判断不分配 Set 且覆盖锚点窗口边界", () => {
    expect(isRecentJoinLogDay("2026-07-31", "2026-07-31", 2)).toBeTrue();
    expect(isRecentJoinLogDay("2026-07-30", "2026-07-31", 2)).toBeTrue();
    expect(isRecentJoinLogDay("2026-07-29", "2026-07-31", 2)).toBeFalse();
    expect(isRecentJoinLogDay("2026-08-01", "2026-07-31", 2)).toBeFalse();
    expect(isRecentJoinLogDay("2026-02-28", "2026-03-01", 2)).toBeTrue();
    expect(isRecentJoinLogDay("2025-12-30", "2026-01-01", 3)).toBeTrue();
    expect(isRecentJoinLogDay("2025-12-29", "2026-01-01", 3)).toBeFalse();
    expect(isRecentJoinLogDay("2026-07-31", "2026-07-31", 1)).toBeTrue();
    expect(isRecentJoinLogDay("2026-07-30", "2026-07-31", 1)).toBeFalse();
    expect(isRecentJoinLogDay("2026-07-31", "2026-07-31", 0)).toBeFalse();
  });

  test("单群单日超出容量线时原子重写权威文件，并只告警一次", async () => {
    // 把 Worker 独占的 latest-by-user 索引预填到容量线 JOIN_LOG_MAX_USERS_PER_CHAT_DAY，再投一条新用户，走 writeFileEntries 里的溢出分支。
    const day: string = getDateKey();
    const key: string = `-1001:${day}`;
    const path: string = currentFile(-1001);
    const base: number = todayMidnight();
    const latestByUser: Map<number, { userId: number; joinedAt: number }> =
      new Map<number, { userId: number; joinedAt: number }>();
    for (let userId: number = 1; userId <= JOIN_LOG_MAX_USERS_PER_CHAT_DAY; userId += 1) {
      latestByUser.set(userId, { userId, joinedAt: base + userId });
    }
    const snapshotBytes: number = measureJoinLogSnapshotBytes(latestByUser);
    // 权威文件先按这份索引落到盘上；溢出分支把它整个换掉，不追加。
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(path, [...joinLogSnapshotChunks(latestByUser)].join(""));
    const cache: JoinLogFileCache = {
      state: { size: snapshotBytes, empty: false },
      latestByUser,
      snapshotBytes,
      appendedBytesSinceCompaction: 0,
      redundantEntries: 0,
      capacityWarningEmitted: false,
    };
    joinLogFileCaches.set(key, cache);
    joinLogRetryAt.set(key, Date.now() + 60_000);

    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const newestJoinedAt: number = base + JOIN_LOG_MAX_USERS_PER_CHAT_DAY + 1;
      const newUserId: number = JOIN_LOG_MAX_USERS_PER_CHAT_DAY + 1;
      markJoinLogDirty({
        sequence: 1,
        chatId: -1001,
        day,
        record: { userId: newUserId, joinedAt: newestJoinedAt },
      });

      expect(await flushJoinLogBuffer()).toBeTrue();

      // 淘汰的是 joinedAt 最旧的那一位，新记录进表，总量仍压在容量线上。
      expect(cache.latestByUser.size).toBe(JOIN_LOG_MAX_USERS_PER_CHAT_DAY);
      expect(cache.latestByUser.has(1)).toBeFalse();
      expect(cache.latestByUser.get(newUserId)).toEqual({
        userId: newUserId,
        joinedAt: newestJoinedAt,
      });

      // 逐条增量记账与整表重算逐字节一致。
      expect(cache.snapshotBytes).toBe(measureJoinLogSnapshotBytes(cache.latestByUser));
      expect(cache.state).toEqual({ size: cache.snapshotBytes, empty: false });
      expect(cache.appendedBytesSinceCompaction).toBe(0);
      expect(cache.redundantEntries).toBe(0);

      // 权威文件被整体重写：字节数与记账一致，被淘汰的键消失、新键在场。
      const written: string = await Bun.file(path).text();
      expect(UTF8_ENCODER.encode(written).byteLength).toBe(cache.snapshotBytes);
      expect(written).not.toContain(`"${base + 1}:1"`);
      expect(written).toContain(`"${newestJoinedAt}:${newUserId}"`);

      // 成功落盘后退避条目清掉。
      expect(joinLogRetryAt.has(key)).toBeFalse();

      expect(cache.capacityWarningEmitted).toBeTrue();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain(
        `exceeded ${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} users; retained the newest records and evicted 1`
      );

      // 同一份缓存再溢出一次只淘汰、不重复告警。
      markJoinLogDirty({
        sequence: 2,
        chatId: -1001,
        day,
        record: { userId: newUserId + 1, joinedAt: newestJoinedAt + 1 },
      });
      expect(await flushJoinLogBuffer()).toBeTrue();
      expect(cache.latestByUser.size).toBe(JOIN_LOG_MAX_USERS_PER_CHAT_DAY);
      expect(cache.snapshotBytes).toBe(measureJoinLogSnapshotBytes(cache.latestByUser));
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  }, 30_000);

  test("同一用户当日重复入群走追加路径并记入 redundantEntries", async () => {
    const day: string = getDateKey();
    const key: string = `-1001:${day}`;
    const first: number = todayAt();
    await handleJoinLogMessage(joinMessage(-1001, 42, first));
    expect(await flushJoinLogBuffer()).toBeTrue();

    const cache: JoinLogFileCache = joinLogFileCaches.get(key)!;
    expect(cache.redundantEntries).toBe(0);
    const bytesAfterFirst: number = cache.snapshotBytes;

    // 同一个 userId、更晚的 joinedAt：折叠层放行，索引里已有这个人，
    // 追加的这条是文件里的冗余历史，由 redundantEntries 记账。
    const second: number = first + 1_000;
    await handleJoinLogMessage(joinMessage(-1001, 42, second));
    expect(await flushJoinLogBuffer()).toBeTrue();

    expect(cache.redundantEntries).toBe(1);
    expect(cache.latestByUser.get(42)).toEqual({ userId: 42, joinedAt: second });
    expect(cache.snapshotBytes).toBe(measureJoinLogSnapshotBytes(cache.latestByUser));
    // 两条记录长度相同，折叠后的快照字节数不变，但物理文件已经多了一条。
    expect(cache.snapshotBytes).toBe(bytesAfterFirst);
    expect(cache.state.size).toBeGreaterThan(cache.snapshotBytes);
    expect(JSON.parse(await Bun.file(currentFile(-1001)).text())).toEqual({
      [`${first}:42`]: { userId: 42, joinedAt: first },
      [`${second}:42`]: { userId: 42, joinedAt: second },
    });
  });

  test("整群删除清掉本群保留窗口内外的全部日志、接管游标与待写事实", async () => {
    const today: string = getDateKey();
    const yesterday: string = getDateKey(todayAt(-24 * 60 * 60_000));
    await handleJoinLogMessage(joinMessage(-1001, 42, todayAt()));
    await flushJoinLogBuffer();
    mkdirSync(joinLogDir, { recursive: true });
    await Bun.write(datedFile(-1001, yesterday), "{}");
    await Bun.write(datedFile(-2002, today), "{}");
    // 删除之前又来了一条本群的入群事实：本群已不再接管，这条不写回。
    markJoinLogDirty({ sequence: 2, chatId: -1001, day: today, record: { userId: 43, joinedAt: todayAt(1) } });
    markJoinLogDirty({ sequence: 3, chatId: -2002, day: today, record: { userId: 44, joinedAt: todayAt(2) } });
    expect(joinLogFileCaches.has(`-1001:${today}`)).toBeTrue();

    handleJoinLogDeleteMessage({ type: "deleteJoinLog", chatId: -1001 });

    expect(existsSync(currentFile(-1001))).toBeFalse();
    expect(existsSync(datedFile(-1001, yesterday))).toBeFalse();
    expect(joinLogFileCaches.has(`-1001:${today}`)).toBeFalse();
    expect(joinLogRetryAt.has(`-1001:${today}`)).toBeFalse();
    expect(joinLogDeletions.size).toBe(0);
    // 只删这一个群：别的群的文件与待写事实都留着。
    expect(existsSync(datedFile(-2002, today))).toBeTrue();
    expect(joinLogBuffer.entries).toEqual([
      { sequence: 3, chatId: -2002, day: today, record: { userId: 44, joinedAt: todayAt(2) } },
    ]);
    expect(purgeJoinLogDeletions()).toBeTrue();
    expect(existsSync(currentFile(-1001))).toBeFalse();
  });

  test("没有日志的群照常删成功，不留待删标记", () => {
    handleJoinLogDeleteMessage({ type: "deleteJoinLog", chatId: -3003 });
    expect(joinLogDeletions.size).toBe(0);
    expect(purgeJoinLogDeletions()).toBeTrue();
  });

  test("删除失败只让 joinLogPurge 回报失败，追写那一格不被连坐", async () => {
    mkdirSync(joinLogDir, { recursive: true });
    // 目录占住文件名：删除对目录失败，本群因此留在待删集合里。
    mkdirSync(currentFile(-1001), { recursive: true });
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      handleJoinLogDeleteMessage({ type: "deleteJoinLog", chatId: -1001 });
      expect(joinLogDeletions.has(-1001)).toBeTrue();
      expect(purgeJoinLogDeletions()).toBeFalse();
      // 别的群的入群事实照常落盘并回报成功：删除失败只影响 joinLogPurge（见 types/diskIO/replies.ts 的 DiskIODomain）。
      await handleJoinLogMessage(joinMessage(-2002, 42, todayAt()));
      expect(await flushJoinLogBuffer()).toBeTrue();

      rmSync(currentFile(-1001), { recursive: true, force: true });
      expect(purgeJoinLogDeletions()).toBeTrue();
      expect(joinLogDeletions.size).toBe(0);
    } finally {
      diagnostic.mockRestore();
    }
  });

  test("拒绝超过 24 小时或倒序的读取区间", async () => {
    const now: number = todayAt();
    await expect(readJoinLog({
      type: "readJoinLog",
      requestId: 5,
      chatId: -1001,
      since: now - 24 * 60 * 60_000 - 1,
      now,
    })).rejects.toThrow("at most 24 hours");
    await expect(readJoinLog({
      type: "readJoinLog",
      requestId: 6,
      chatId: -1001,
      since: now + 1,
      now,
    })).rejects.toThrow("at most 24 hours");
  });
});
