import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../../preloadEnv";

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "join-log-files-test-"));
const joinLogDir: string = join(testRoot, "joinlog");
const UTF8_ENCODER: TextEncoder = new TextEncoder();
const realPaths = await import("../../../packages/consts/paths");
mock.module("../../../packages/consts/paths", () => ({
  ...realPaths,
  JOIN_LOG_MEMORY_DIR: joinLogDir,
}));
const realAtomicFile = await import("../../../packages/libs/atomicFile");
const realAtomicWriteTextChunksSync: typeof realAtomicFile.atomicWriteTextChunksSync =
  realAtomicFile.atomicWriteTextChunksSync;
/**
 * 快照原子重写的故障注入档位：null 走真实实现；beforeRename 在碰目标文件前抛错
 * （等价于写临时文件时 ENOSPC）；afterRename 让真实实现完成持久替换后再抛错。
 */
const snapshotRewriteFault: { current: "beforeRename" | "afterRename" | null } = { current: null };
mock.module("../../../packages/libs/atomicFile", () => ({
  ...realAtomicFile,
  atomicWriteTextChunksSync: (path: string, chunks: Iterable<string>, mode?: number): number => {
    if (snapshotRewriteFault.current === "beforeRename") {
      throw Object.assign(new Error("ENOSPC: no space left on device (injected)"), { code: "ENOSPC" });
    }
    const size: number = realAtomicWriteTextChunksSync(path, chunks, mode);
    if (snapshotRewriteFault.current === "afterRename") {
      throw Object.assign(new Error("EIO: directory fsync failed (injected)"), { code: "EIO" });
    }
    return size;
  },
}));

const {
  flushJoinLogBuffer,
  flushJoinLogDomain,
  handleJoinLogDeleteMessage,
  handleJoinLogMessage,
  purgeJoinLogDeletions,
  inspectJoinLogFiles,
  maintainJoinLogFiles,
  maintainJoinLogRetention,
  readJoinLog,
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
  joinLogDeletions,
  joinLogFileCaches,
  joinLogRetryAt,
  markJoinLogDirty,
  noteJoinLogRejected,
  resetJoinLogCache,
} = await import("../../../packages/cache/workers/diskIO/joinLog");
const {
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
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
    day: getTokyoDateKey(joinedAt),
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

/**
 * 单领域恢复的测试编排：按生产 handleDiskIOStartupLoad 的顺序跑
 * inspect -> maintenance（见 workers/diskIO/startup.ts）。生产没有这个包装。
 */
async function recoverJoinLogFiles(today?: string): Promise<void> {
  const inspection = today === undefined
    ? await inspectJoinLogFiles(getTokyoDateKey())
    : await inspectJoinLogFiles(today);
  await maintainJoinLogFiles(inspection);
}

beforeEach(() => {
  rmSync(joinLogDir, { recursive: true, force: true });
  resetJoinLogCache();
});

afterEach(() => {
  snapshotRewriteFault.current = null;
  resetJoinLogCache();
  rmSync(joinLogDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/**
 * 造一份**语义合法但物理上全是历史条目**的当日追加文件：只有 userCount 个
 * 用户，每人反复重新入群。`latestJoinLogRecords` 折叠之后活的就那么几条，
 * 文件里剩下的全是可回收的字节。
 */
async function writeRedundantJoinLogFile(
  chatId: number,
  userCount: number,
  targetBytes: number
): Promise<number> {
  const parts: string[] = [];
  let bytes: number = 2;
  let joinedAt: number = todayMidnight();
  for (let index: number = 0; bytes < targetBytes; index += 1) {
    const userId: number = 1 + (index % userCount);
    joinedAt += 1;
    const entry: string = serializeJoinLogSnapshotEntry({ userId, joinedAt });
    parts.push(entry);
    bytes += entry.length + 2;
  }
  const content: string = `{\n${parts.join(",\n")}\n}`;
  mkdirSync(joinLogDir, { recursive: true });
  await Bun.write(currentFile(chatId), content);
  return UTF8_ENCODER.encode(content).byteLength;
}

/** 读回当前文件并确认它是合法 JSON、物理字节与 cache 游标一致。 */
async function expectFileMatchesCache(
  chatId: number
): Promise<Record<string, { userId: number; joinedAt: number }>> {
  const content: string = await Bun.file(currentFile(chatId)).text();
  const parsed: Record<string, { userId: number; joinedAt: number }> = JSON.parse(content);
  const cache: JoinLogFileCache | undefined =
    joinLogFileCaches.get(`${chatId}:${getTokyoDateKey()}`);
  expect(cache?.state.size).toBe(UTF8_ENCODER.encode(content).byteLength);
  return parsed;
}

export {
  joinLogDir,
  UTF8_ENCODER,
  snapshotRewriteFault,
  flushJoinLogBuffer,
  flushJoinLogDomain,
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
  noteJoinLogRejected,
  resetJoinLogCache,
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_SNAPSHOT_CHUNK_BYTES,
  getTokyoDateKey,
  joinMessage,
  currentFile,
  datedFile,
  todayAt,
  todayMidnight,
  recoverJoinLogFiles,
  writeRedundantJoinLogFile,
  expectFileMatchesCache,
};
