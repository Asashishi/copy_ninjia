import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskIOMessage } from "../../packages/types";

const handleLogMessage = mock((_message: unknown): void => {});
const markAiMemorySnapshotDirty = mock((_input: unknown): void => {});
const deleteAiMemorySnapshot = mock((_chatId: number, _revision: number): void => {});
const markStickerCatalogSnapshotDirty = mock((_pack: string, _snapshot: string): void => {});
const handleLuckDrawMessage = mock((_message: unknown): void => {});
const handleVerificationUpsert = mock((_input: unknown): void => {});
const handleVerificationDelete = mock((_input: unknown): void => {});
interface LuckSecretRecoveryInput {
  day: string;
  confirmedResultCount: number;
}
const recoverLuckReceiptSecret = mock((input: LuckSecretRecoveryInput): {
  version: 1;
  day: string;
  key: string;
} => ({
  version: 1,
  day: input.day,
  key: "secret",
}));
const luckWorkerCache: {
  current: { day: string; entries: Map<string, { label: string; fortunePercent: number }> } | null;
} = { current: null };
type HydratedLuckEntries = Map<string, { label: string; fortunePercent: number }>;
let hydratedLuckEntries: HydratedLuckEntries = new Map();
const hydrateLuckDay = mock((day: string): void => {
  luckWorkerCache.current = { day, entries: new Map(hydratedLuckEntries) };
});
const flushLogBuffer = mock((): boolean => true);
const flushAiMemorySnapshots = mock((): boolean => true);
const flushStickerCatalogs = mock((): boolean => true);
const flushLuckAppends = mock((): boolean => true);
const flushVerificationChanges = mock((_reply: (reply: unknown) => void): boolean => true);
const flushBlocklistRemovalOutbox = mock((): boolean => true);
const handleBlocklistRemovalsMessage = mock((_message: unknown): void => {});
const postMessage = mock((_reply: unknown): void => {});
const hydrateStickerCatalogs = mock((_packs: readonly string[] | null): Map<string, string> => new Map());
// 贴纸白名单是全进程唯一无条件读 config/stickers.json 的地方；写坏时必须整体
// 跳过对账（见 diskIOWorker.ts 的 activeStickerPacks）。
let stickerConfigFailure: string | null = null;
const consoleError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/workers/diskIO/logFiles", () => ({
  flushLogBuffer,
  handleLogMessage,
  initLogFiles: (): void => {},
}));
mock.module("../../packages/workers/diskIO/luckFiles", () => ({
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
}));
mock.module("../../packages/workers/diskIO/luckSecretFile", () => ({ recoverLuckReceiptSecret }));
mock.module("../../packages/cache/workers/diskIO/luck", () => ({ luckWorkerCache }));
mock.module("../../packages/workers/diskIO/verificationFiles", () => ({
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  recoverVerificationDay: (): Map<string, unknown> => new Map(),
  scheduleVerificationRollover: (): void => {},
}));
mock.module("../../packages/workers/diskIO/aiMemoryFiles", () => ({
  configureAiMemoryDeletePersistedReply: (): void => {},
  configureAiMemoryPersistedReply: (): void => {},
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,
  hydrateAiMemorySnapshots: (): Map<number, string> => new Map(),
  markAiMemorySnapshotDirty,
}));
mock.module("../../packages/workers/diskIO/stickerCatalogFiles", () => ({
  flushStickerCatalogs,
  hydrateStickerCatalogs,
  markStickerCatalogSnapshotDirty,
}));
mock.module("../../packages/config/stickers", () => ({
  getStickerConfig: (): { packs: readonly string[] } => {
    if (stickerConfigFailure !== null) throw new Error(stickerConfigFailure);
    return { packs: ["pack_a"] };
  },
}));
mock.module("../../packages/workers/diskIO/blocklistRemovalOutbox", () => ({
  flushBlocklistRemovalOutbox,
  handleBlocklistRemovalsMessage,
  hydrateBlocklistRemovalOutbox: (): Map<number, never> => new Map<number, never>(),
}));

const workerGlobal = globalThis as typeof globalThis & { postMessage: (message: unknown) => void };
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = postMessage;
const { handleDiskIOWorkerMessage } = await import("../../packages/workers/diskIOWorker");

afterAll(() => {
  workerGlobal.postMessage = originalPostMessage;
});

beforeEach(() => {
  for (const fn of [
    handleLogMessage,
    markAiMemorySnapshotDirty,
    deleteAiMemorySnapshot,
    markStickerCatalogSnapshotDirty,
    handleLuckDrawMessage,
    handleVerificationUpsert,
    handleVerificationDelete,
    flushLogBuffer,
    flushAiMemorySnapshots,
    flushStickerCatalogs,
    flushLuckAppends,
    flushVerificationChanges,
    flushBlocklistRemovalOutbox,
    handleBlocklistRemovalsMessage,
    postMessage,
    hydrateLuckDay,
    hydrateStickerCatalogs,
    consoleError,
  ]) fn.mockClear();
  stickerConfigFailure = null;
  luckWorkerCache.current = null;
  hydratedLuckEntries = new Map();
  recoverLuckReceiptSecret.mockReset();
  recoverLuckReceiptSecret.mockImplementation((input) => ({ version: 1, day: input.day, key: "secret" }));
  flushLogBuffer.mockReturnValue(true);
  flushAiMemorySnapshots.mockReturnValue(true);
  flushStickerCatalogs.mockReturnValue(true);
  flushLuckAppends.mockReturnValue(true);
  flushVerificationChanges.mockReturnValue(true);
  flushBlocklistRemovalOutbox.mockReturnValue(true);
});

function route(message: DiskIOMessage): void {
  handleDiskIOWorkerMessage(message);
}

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", () => {
    route({ type: "log", timestamp: 1, level: "error", args: ["boom"] });
    route({
      type: "aiMemory",
      chatId: -1,
      revision: 2,
      snapshot: "memory",
      persistImmediately: true,
    });
    route({ type: "deleteAiMemory", chatId: -1, revision: 3 });
    route({ type: "stickerCatalog", pack: "pack", snapshot: "catalog" });
    route({ type: "luckDraw", day: "2026-07-22", key: "42", label: "大吉", fortunePercent: 99 });
    route({ type: "verificationDelete", chatId: -1, userId: 42, generation: 1, revision: 4 });
    route({ type: "blocklistRemovals", removals: [] });

    expect(handleLogMessage).toHaveBeenCalledTimes(1);
    expect(markAiMemorySnapshotDirty).toHaveBeenCalledWith({
      chatId: -1,
      revision: 2,
      snapshot: "memory",
      persistImmediately: true,
    });
    expect(deleteAiMemorySnapshot).toHaveBeenCalledWith(-1, 3);
    expect(markStickerCatalogSnapshotDirty).toHaveBeenCalledWith("pack", "catalog");
    expect(handleLuckDrawMessage).toHaveBeenCalledTimes(1);
    expect(handleVerificationDelete).toHaveBeenCalledTimes(1);
    expect(handleBlocklistRemovalsMessage).toHaveBeenCalledTimes(1);
  });

  test("密钥请求总有显式成功或失败回执", () => {
    hydratedLuckEntries.set("confirmed", { label: "大吉", fortunePercent: 99 });
    route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 8 });
    expect(flushLuckAppends).toHaveBeenCalledTimes(1);
    expect(hydrateLuckDay).toHaveBeenCalledWith("2026-07-22");
    expect(recoverLuckReceiptSecret).toHaveBeenLastCalledWith({
      day: "2026-07-22",
      confirmedResultCount: 1,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 8,
      secret: { version: 1, day: "2026-07-22", key: "secret" },
    });

    recoverLuckReceiptSecret.mockImplementationOnce(() => { throw new Error("corrupt secret"); });
    route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 9 });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 9,
      error: "corrupt secret",
    });
  });

  test("跨日密钥请求先提交旧日追加缓冲，刷盘失败时不切换 owner", () => {
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };

    route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 10 });

    expect(flushLuckAppends).toHaveBeenCalledTimes(1);
    expect(hydrateLuckDay).toHaveBeenCalledWith("2026-07-22");
    expect(flushLuckAppends.mock.invocationCallOrder[0]).toBeLessThan(hydrateLuckDay.mock.invocationCallOrder[0]!);

    flushLuckAppends.mockClear();
    hydrateLuckDay.mockClear();
    recoverLuckReceiptSecret.mockClear();
    postMessage.mockClear();
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };
    flushLuckAppends.mockReturnValueOnce(false);

    route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 11 });

    expect(hydrateLuckDay).not.toHaveBeenCalled();
    expect(recoverLuckReceiptSecret).not.toHaveBeenCalled();
    expect(luckWorkerCache.current.day).toBe("2026-07-21");
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 11,
      error: "Failed to flush luck results before switching from 2026-07-21 to 2026-07-22.",
    });
  });

  test("启动恢复先加载当天结果，再把确认数交给密钥一致性检查", () => {
    hydratedLuckEntries.set("confirmed", { label: "大吉", fortunePercent: 99 });

    route({ type: "load" });

    expect(hydrateLuckDay).toHaveBeenCalledTimes(1);
    expect(recoverLuckReceiptSecret).toHaveBeenLastCalledWith({
      day: expect.any(String),
      confirmedResultCount: 1,
    });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      luckReceiptSecret: expect.objectContaining({ key: "secret" }),
      error: undefined,
    }));
  });

  test("贴纸白名单写坏时降级成只读不删，其余恢复照常并不报启动失败", () => {
    stickerConfigFailure = "Invalid stickers config: boom";
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      route({ type: "load" });
    } finally {
      console.error = originalConsoleError;
    }

    // null 而不是 []：后者会让 recoverStickerCatalogs 把不在白名单里的持久化
    // 文件当孤儿删掉，一个逗号写错就等于清空 memory/stickers/。也不能整步跳过
    // ——那会让内存里的目录停在空表，而磁盘上明明躺着完好的快照。
    expect(hydrateStickerCatalogs).toHaveBeenCalledTimes(1);
    expect(hydrateStickerCatalogs).toHaveBeenCalledWith(null);
    expect(consoleError).toHaveBeenCalledTimes(1);
    // 其余 owner 照常恢复；这一份坏文件不该把整个进程拦在启动阶段。
    expect(hydrateLuckDay).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: undefined,
    }));
  });

  test("白名单可读时原样传下去，孤儿清理照常生效", () => {
    route({ type: "load" });

    expect(hydrateStickerCatalogs).toHaveBeenCalledWith(["pack_a"]);
  });

  test("flush 不短路其它 owner，并按领域回报失败", () => {
    flushAiMemorySnapshots.mockReturnValueOnce(false);
    route({ type: "flush", flushId: 11 });

    for (const fn of [
      flushLogBuffer,
      flushAiMemorySnapshots,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    // 按领域而不是一个合取布尔：等自己那条记录落盘的调用方（/block）不该被
    // 无关领域的失败误导——那会把运维引向一个其实没坏的文件，而真正坏掉的
    // 领域按设计只有 console.error，永远进不了 logs/。
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 11,
      failedDomains: ["aiMemory"],
    });

    flushBlocklistRemovalOutbox.mockReturnValueOnce(false);
    route({ type: "flush", flushId: 12 });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 12,
      failedDomains: ["blocklistRemovalOutbox"],
    });
  });

  test("七个领域全部成功时回执不带失败领域", () => {
    route({ type: "flush", flushId: 13 });

    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 13 });
  });
});
