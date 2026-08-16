import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot: string = mkdtempSync(join(tmpdir(), "join-log-files-test-"));
const joinLogDir: string = join(testRoot, "joinlog");
const realPaths = await import("../../../packages/consts/paths");
mock.module("../../../packages/consts/paths", () => ({
  ...realPaths,
  JOIN_LOG_MEMORY_DIR: joinLogDir,
}));

const {
  flushJoinLogBuffer,
  flushJoinLogDomain,
  handleJoinLogMessage,
  readJoinLog,
  recoverJoinLogFiles,
} = await import("../../../packages/workers/diskIO/joinLogFiles");
const {
  isRecentJoinLogDay,
  joinLogSnapshotChunks,
  measureJoinLogSnapshotBytes,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} = await import("../../../packages/workers/diskIO/joinLogRecords");
const {
  joinLogBuffer,
  joinLogFileCaches,
  joinLogRetryAt,
  markJoinLogDirty,
  noteJoinLogRejected,
  resetJoinLogCache,
} = await import("../../../packages/cache/workers/diskIO/joinLog");
const {
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
  JOIN_LOG_SNAPSHOT_CHUNK_BYTES,
} = await import("../../../packages/consts/diskIO/joinLog");
const { getTokyoDateKey } = await import("../../../packages/libs/time");
import type { JoinLogDiskMessage } from "../../../packages/types/diskIO";
import type { JoinLogFileCache } from "../../../packages/types/diskIO/storage";

function joinMessage(
  chatId: number,
  userId: number,
  joinedAt: number
): JoinLogDiskMessage {
  return {
    type: "joinLog",
    chatId,
    userId,
    joinedAt,
    day: getTokyoDateKey(new Date(joinedAt)),
  };
}

function currentFile(chatId: number): string {
  return join(joinLogDir, `${chatId}.${getTokyoDateKey()}.json`);
}

function datedFile(chatId: number, day: string): string {
  return join(joinLogDir, `${chatId}.${day}.json`);
}

/** 取东京当天中午，避免用 Date.now()-偏移量时在午夜附近跨日造成测试偶发失败。 */
function todayAt(offsetMs: number = 0): number {
  return Date.parse(`${getTokyoDateKey()}T12:00:00+09:00`) + offsetMs;
}

function todayMidnight(): number {
  return Date.parse(`${getTokyoDateKey()}T00:00:00+09:00`);
}

beforeEach(() => {
  rmSync(joinLogDir, { recursive: true, force: true });
  resetJoinLogCache();
});

afterEach(() => {
  resetJoinLogCache();
  rmSync(joinLogDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("diskIO/joinLogFiles", () => {
  test("模块加载本身不创建、不读取入群目录", () => {
    expect(existsSync(joinLogDir)).toBeFalse();
  });

  test("启动恢复会扫描保留窗口，坏状态阻止过期清理并保持原字节", () => {
    const currentPath: string = currentFile(-1001);
    const stalePath: string = datedFile(-1001, "2000-01-01");
    const original: string = "{\"bad\":{\"userId\":42,\"joinedAt\":\"now\"}}";
    mkdirSync(joinLogDir, { recursive: true });
    writeFileSync(currentPath, original);
    writeFileSync(stalePath, "{}");

    expect(() => recoverJoinLogFiles()).toThrow("$.<record> must be exactly");
    expect(readFileSync(currentPath, "utf8")).toBe(original);
    expect(existsSync(stalePath)).toBeTrue();
    expect(joinLogFileCaches.size).toBe(0);
  });

  test("启动恢复拒绝非法或未来文件名，不把它们当成可忽略资产", () => {
    const invalidPath: string = join(joinLogDir, "bad.json");
    mkdirSync(joinLogDir, { recursive: true });
    writeFileSync(invalidPath, "{}");

    expect(() => recoverJoinLogFiles()).toThrow("canonical <chatId>.<YYYY-MM-DD>.json form");
    expect(readFileSync(invalidPath, "utf8")).toBe("{}");

    rmSync(invalidPath);
    const invalidDayPath: string = datedFile(-1001, "2026-02-30");
    writeFileSync(invalidDayPath, "{}");
    expect(() => recoverJoinLogFiles()).toThrow("a canonical calendar date");
    expect(readFileSync(invalidDayPath, "utf8")).toBe("{}");

    rmSync(invalidDayPath);
    const futureDay: string = getTokyoDateKey(new Date(todayAt() + 2 * 24 * 60 * 60_000));
    const futurePath: string = datedFile(-1001, futureDay);
    writeFileSync(futurePath, "{}");
    expect(() => recoverJoinLogFiles()).toThrow("a date no later than the current Tokyo day");
    expect(readFileSync(futurePath, "utf8")).toBe("{}");
  });

  test("启动恢复拒绝以正数私聊 ID 命名的入群日志", () => {
    const path: string = currentFile(1001);
    mkdirSync(joinLogDir, { recursive: true });
    writeFileSync(path, "{}");

    expect(() => recoverJoinLogFiles()).toThrow("negative safe-integer Telegram group or channel ID");
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test("入群先进入内存批次，flush 后按群追写当天 JSON 文件", () => {
    const now: number = todayAt();
    handleJoinLogMessage(joinMessage(-1001, 42, now));
    handleJoinLogMessage(joinMessage(-1002, 43, now + 1));

    expect(joinLogBuffer.entries).toHaveLength(2);
    expect(joinLogBuffer.timer).not.toBeNull();
    expect(existsSync(currentFile(-1001))).toBeFalse();

    expect(flushJoinLogBuffer()).toBeTrue();
    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(joinLogBuffer.timer).toBeNull();
    expect(JSON.parse(readFileSync(currentFile(-1001), "utf8"))).toEqual({
      [`${now}:42`]: { userId: 42, joinedAt: now },
    });
    expect(JSON.parse(readFileSync(currentFile(-1002), "utf8"))).toEqual({
      [`${now + 1}:43`]: { userId: 43, joinedAt: now + 1 },
    });
  });

  test("命令读取前刷新缓冲、按时间过滤，并把同一用户折叠到最后一次加入", () => {
    const now: number = todayAt();
    handleJoinLogMessage(joinMessage(-1001, 42, now - 30_000));
    handleJoinLogMessage(joinMessage(-1001, 42, now - 10_000));
    handleJoinLogMessage(joinMessage(-1001, 43, now - 5_000));
    handleJoinLogMessage(joinMessage(-1001, 44, now - 60_000));

    const records = readJoinLog({
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

  test("滚动窗口跨午夜合并两个自然日，并按用户保留最后一次加入", () => {
    const midnight: number = todayMidnight();
    const beforeMidnight: number = midnight - 10 * 60_000;
    const afterMidnight: number = midnight + 5 * 60_000;
    const now: number = midnight + 10 * 60_000;
    handleJoinLogMessage(joinMessage(-1001, 42, beforeMidnight));
    handleJoinLogMessage(joinMessage(-1001, 43, beforeMidnight + 1));
    handleJoinLogMessage(joinMessage(-1001, 42, afterMidnight));

    expect(readJoinLog({
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
      getTokyoDateKey(new Date(beforeMidnight))
    ))).toBeTrue();
    expect(existsSync(currentFile(-1001))).toBeTrue();
  });

  test("首次写入或命令读取保留最近三个自然日并清理更旧日志与孤儿临时文件", () => {
    const today: string = getTokyoDateKey();
    const twoDaysAgo: string =
      getTokyoDateKey(new Date(todayAt() - 2 * 24 * 60 * 60_000));
    mkdirSync(joinLogDir, { recursive: true });
    const stalePath: string = join(joinLogDir, "-1001.2000-01-01.json");
    const retainedPath: string =
      join(joinLogDir, `-1001.${twoDaysAgo}.json`);
    const currentOtherChatPath: string =
      join(joinLogDir, `-1002.${today}.json`);
    const tmpPath: string = join(joinLogDir, "orphan.json.tmp");
    const unrelatedPath: string = join(joinLogDir, "notes.txt");
    writeFileSync(stalePath, "{}");
    writeFileSync(retainedPath, "{}");
    writeFileSync(currentOtherChatPath, "{}");
    writeFileSync(tmpPath, "partial");
    writeFileSync(unrelatedPath, "keep");

    expect(readJoinLog({
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

  test("可解析但 schema 错误的当前日志拒绝读取并保留原字节", () => {
    const path: string = currentFile(-1001);
    mkdirSync(joinLogDir, { recursive: true });
    const original: string = "{\"bad\":{\"userId\":42,\"joinedAt\":\"now\"}}";
    writeFileSync(path, original);

    expect(() => readJoinLog({
      type: "readJoinLog",
      requestId: 3,
      chatId: -1001,
      since: todayAt() - 60_000,
      now: todayAt(),
    })).toThrow("$.<record> must be exactly");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("跨日重投的旧事件不重新创建历史文件", () => {
    const staleAt: number = todayAt() - 3 * 24 * 60 * 60_000;
    handleJoinLogMessage(joinMessage(-1001, 42, staleAt));

    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(existsSync(joinLogDir)).toBeFalse();
  });

  test("领先本机今天的事件抛错交给统一拒收出口，不静默丢弃", () => {
    // 与上一条「过旧」用例正好相反的一侧：过旧是有意静默丢弃（滚动 24 小时窗口
    // 本来就用不上，报失败只会让 update 永远得不到确认）；领先则说明事件时间与
    // 宿主时钟对不上，静默 return 会让 recordJoinLog 把它当成已经落盘，这条入群
    // 从此在 /batch_kick 里查无此人、全链路零日志。
    const aheadAt: number = todayAt() + 2 * 24 * 60 * 60_000;

    expect(() => handleJoinLogMessage(joinMessage(-1001, 42, aheadAt)))
      .toThrow("is ahead of the worker's current Tokyo day");
    expect(joinLogBuffer.entries).toHaveLength(0);
    expect(existsSync(joinLogDir)).toBeFalse();
  });

  test("同一事件重投不会增加物理文件字节", () => {
    const now: number = todayAt();
    const message: JoinLogDiskMessage = joinMessage(-1001, 42, now);
    handleJoinLogMessage(message);
    expect(flushJoinLogBuffer()).toBeTrue();
    const firstContent: string = readFileSync(currentFile(-1001), "utf8");

    handleJoinLogMessage(message);
    expect(flushJoinLogBuffer()).toBeTrue();

    expect(readFileSync(currentFile(-1001), "utf8")).toBe(firstContent);
    const cache: JoinLogFileCache | undefined =
      joinLogFileCaches.get(`-1001:${getTokyoDateKey()}`);
    expect(cache).toBeDefined();
    if (cache === undefined) throw new Error("Join log cache was not built.");
    expect(cache.snapshotBytes).toBe(
      measureJoinLogSnapshotBytes(cache.latestByUser)
    );
  });

  test("一万次精确重投仍只保留一条物理与逻辑记录", () => {
    const now: number = todayAt();
    const message: JoinLogDiskMessage = joinMessage(-1001, 42, now);
    for (let index: number = 0; index < 10_000; index += 1) {
      handleJoinLogMessage(message);
    }
    expect(flushJoinLogBuffer()).toBeTrue();

    const content: string = readFileSync(currentFile(-1001), "utf8");
    expect(JSON.parse(content)).toEqual({
      [`${now}:42`]: { userId: 42, joinedAt: now },
    });
    expect(content.match(new RegExp(`"${now}:42"`, "g"))).toHaveLength(1);
  });

  test("写失败时保留原批次并退避，文件恢复后可再次 flush", () => {
    const now: number = todayAt();
    const path: string = currentFile(-1001);
    mkdirSync(path, { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      handleJoinLogMessage(joinMessage(-1001, 42, now));

      expect(flushJoinLogBuffer()).toBeFalse();
      expect(joinLogBuffer.entries).toEqual([{
        chatId: -1001,
        day: getTokyoDateKey(),
        record: { userId: 42, joinedAt: now },
      }]);
      expect(joinLogBuffer.timer).not.toBeNull();

      rmSync(path, { recursive: true, force: true });
      joinLogRetryAt.clear();
      expect(flushJoinLogBuffer()).toBeTrue();
      expect(joinLogBuffer.entries).toHaveLength(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        [`${now}:42`]: { userId: 42, joinedAt: now },
      });
    } finally {
      error.mockRestore();
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
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(
        JOIN_LOG_SNAPSHOT_CHUNK_BYTES + 2
      );
    }
    expect(Buffer.byteLength(content)).toBe(
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

  test("群日索引使用 LRU 并始终受硬顶约束", () => {
    const now: number = todayAt();
    const day: string = getTokyoDateKey();
    mkdirSync(joinLogDir, { recursive: true });
    for (
      let index: number = 0;
      index <= JOIN_LOG_MAX_CACHED_FILES;
      index += 1
    ) {
      writeFileSync(datedFile(-10_000 - index, day), "{}");
    }
    const readEmpty: (chatId: number) => void = (chatId: number): void => {
      expect(readJoinLog({
        type: "readJoinLog",
        requestId: Math.abs(chatId),
        chatId,
        since: now - 60_000,
        now,
      })).toEqual([]);
    };
    for (let index: number = 0; index < JOIN_LOG_MAX_CACHED_FILES; index += 1) {
      readEmpty(-10_000 - index);
    }
    readEmpty(-10_000);
    readEmpty(-10_000 - JOIN_LOG_MAX_CACHED_FILES);

    expect(joinLogFileCaches.size).toBe(JOIN_LOG_MAX_CACHED_FILES);
    expect(joinLogFileCaches.has(`-10000:${day}`)).toBeTrue();
    expect(joinLogFileCaches.has(`-10001:${day}`)).toBeFalse();
  });

  test("回归：一个群写不动时，其它群的按需读取照常成功", () => {
    const now: number = todayAt();
    // 群 A 的当天文件被目录占位，写入必然失败并留在缓冲里退避。
    const brokenPath: string = currentFile(-1001);
    mkdirSync(brokenPath, { recursive: true });
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      handleJoinLogMessage(joinMessage(-1001, 42, now - 10_000));
      handleJoinLogMessage(joinMessage(-2002, 77, now - 10_000));

      // 群 B 的日志本身完好：读取不得被群 A 的写失败连坐。
      expect(readJoinLog({
        type: "readJoinLog",
        requestId: 9,
        chatId: -2002,
        since: now - 20_000,
        now,
      })).toEqual([{ userId: 77, joinedAt: now - 10_000 }]);

      // 群 A 自己的读取仍要如实报错，且点名是哪个群哪一天。
      expect(() => readJoinLog({
        type: "readJoinLog",
        requestId: 10,
        chatId: -1001,
        since: now - 20_000,
        now,
      })).toThrow(`Failed to flush pending join logs for chat -1001 on ${getTokyoDateKey()} before reading.`);
    } finally {
      error.mockRestore();
      rmSync(brokenPath, { recursive: true, force: true });
    }
  });

  test("失败退避表受独立硬顶约束，淘汰不丢待刷事实", () => {
    const now: number = todayAt();
    mkdirSync(joinLogDir, { recursive: true });
    for (
      let index: number = 0;
      index <= JOIN_LOG_MAX_RETRY_FILES;
      index += 1
    ) {
      const chatId: number = -20_000 - index;
      mkdirSync(currentFile(chatId));
      handleJoinLogMessage(joinMessage(chatId, index + 1, now + index));
    }
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      expect(flushJoinLogBuffer()).toBeFalse();
    } finally {
      error.mockRestore();
    }

    expect(joinLogRetryAt.size).toBe(JOIN_LOG_MAX_RETRY_FILES);
    expect(joinLogBuffer.entries).toHaveLength(
      JOIN_LOG_MAX_RETRY_FILES + 1
    );
  });

  test("待刷缓冲达到硬顶后拒绝新增且不覆盖旧事实", () => {
    const day: string = getTokyoDateKey();
    for (
      let index: number = 0;
      index < JOIN_LOG_MAX_BUFFERED_ENTRIES;
      index += 1
    ) {
      expect(markJoinLogDirty({
        chatId: -30_000,
        day,
        record: { userId: index + 1, joinedAt: index + 1 },
      })).toBe(index + 1);
    }

    expect(() => markJoinLogDirty({
      chatId: -30_000,
      day,
      record: { userId: 999_999, joinedAt: 999_999 },
    })).toThrow("hard limit");
    expect(joinLogBuffer.entries).toHaveLength(
      JOIN_LOG_MAX_BUFFERED_ENTRIES
    );
    expect(joinLogBuffer.entries[0]?.record.userId).toBe(1);
  });

  test("拒收标记只拖垮 joinLog 领域，且被统一 flush 消费一次后即清零", () => {
    const day: string = getTokyoDateKey();
    handleJoinLogMessage({ type: "joinLog", chatId: -31_000, userId: 7, joinedAt: 1_000, day });

    // 缓冲里的条目照常写盘成功，但这一轮有事实压根没进来（缓冲满、跨日刷盘
    // 失败、清理抛错都会走到这里），领域出口必须回报失败：主线程的 durability
    // barrier 据此拒绝确认那条 update，Telegram 重投。
    noteJoinLogRejected();
    expect(flushJoinLogDomain()).toBeFalse();
    expect(joinLogBuffer.entries).toHaveLength(0);

    // 一次性消费：重投的下一条不该被上一条的失败连坐。
    expect(flushJoinLogDomain()).toBeTrue();
    // 内部调用方（跨日准备、按需读取）判断的始终只是「缓冲写进去了没有」。
    expect(flushJoinLogBuffer()).toBeTrue();
  });

  test("单日判断不分配 Set 且覆盖锚点窗口边界", () => {
    expect(isRecentJoinLogDay("2026-07-31", "2026-07-31", 2)).toBeTrue();
    expect(isRecentJoinLogDay("2026-07-30", "2026-07-31", 2)).toBeTrue();
    expect(isRecentJoinLogDay("2026-07-29", "2026-07-31", 2)).toBeFalse();
  });

  test("拒绝超过 24 小时或倒序的读取区间", () => {
    const now: number = todayAt();
    expect(() => readJoinLog({
      type: "readJoinLog",
      requestId: 5,
      chatId: -1001,
      since: now - 24 * 60 * 60_000 - 1,
      now,
    })).toThrow("at most 24 hours");
    expect(() => readJoinLog({
      type: "readJoinLog",
      requestId: 6,
      chatId: -1001,
      since: now + 1,
      now,
    })).toThrow("at most 24 hours");
  });
});
