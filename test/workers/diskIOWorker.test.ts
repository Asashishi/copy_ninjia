import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskIOMessage } from "../../src/types";

const handleLogMessage = mock((_message: unknown): void => {});
const markAiMemorySnapshotDirty = mock((_chatId: number, _revision: number, _snapshot: string): void => {});
const deleteAiMemorySnapshot = mock((_chatId: number, _revision: number): void => {});
const markStickerCatalogSnapshotDirty = mock((_pack: string, _snapshot: string): void => {});
const handleLuckDrawMessage = mock((_message: unknown): void => {});
const handleVerificationUpsert = mock((_input: unknown): void => {});
const handleVerificationDelete = mock((_input: unknown): void => {});
const recoverLuckReceiptSecret = mock((_day: string): { version: 1; day: string; key: string } => ({
  version: 1,
  day: "2026-07-22",
  key: "secret",
}));
const flushLogBuffer = mock((): boolean => true);
const flushAiMemorySnapshots = mock((): boolean => true);
const flushStickerCatalogs = mock((): boolean => true);
const flushLuckAppends = mock((): boolean => true);
const flushVerificationChanges = mock((_reply: (reply: unknown) => void): boolean => true);
const postMessage = mock((_reply: unknown): void => {});

mock.module("../../src/workers/diskIO/logFiles", () => ({
  flushLogBuffer,
  handleLogMessage,
  initLogFiles: (): void => {},
}));
mock.module("../../src/workers/diskIO/luckFiles", () => ({
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay: (): void => {},
}));
mock.module("../../src/workers/diskIO/luckSecretFile", () => ({ recoverLuckReceiptSecret }));
mock.module("../../src/workers/diskIO/verificationFiles", () => ({
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  recoverVerificationDay: (): Map<string, unknown> => new Map(),
  scheduleVerificationRollover: (): void => {},
}));
mock.module("../../src/workers/diskIO/aiMemoryFiles", () => ({
  configureAiMemoryDeletePersistedReply: (): void => {},
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,
  hydrateAiMemorySnapshots: (): Map<number, string> => new Map(),
  markAiMemorySnapshotDirty,
}));
mock.module("../../src/workers/diskIO/stickerCatalogFiles", () => ({
  flushStickerCatalogs,
  hydrateStickerCatalogs: (): Map<string, string> => new Map(),
  markStickerCatalogSnapshotDirty,
}));

const workerGlobal = globalThis as typeof globalThis & { postMessage: (message: unknown) => void };
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = postMessage;
const { handleDiskIOWorkerMessage } = await import("../../src/workers/diskIOWorker");

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
    postMessage,
  ]) fn.mockClear();
  recoverLuckReceiptSecret.mockReset();
  recoverLuckReceiptSecret.mockImplementation((day) => ({ version: 1, day, key: "secret" }));
  flushLogBuffer.mockReturnValue(true);
  flushAiMemorySnapshots.mockReturnValue(true);
  flushStickerCatalogs.mockReturnValue(true);
  flushLuckAppends.mockReturnValue(true);
  flushVerificationChanges.mockReturnValue(true);
});

function route(message: DiskIOMessage): void {
  handleDiskIOWorkerMessage(message);
}

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", () => {
    route({ type: "log", timestamp: 1, level: "error", args: ["boom"] });
    route({ type: "aiMemory", chatId: -1, revision: 2, snapshot: "memory" });
    route({ type: "deleteAiMemory", chatId: -1, revision: 3 });
    route({ type: "stickerCatalog", pack: "pack", snapshot: "catalog" });
    route({ type: "luckDraw", day: "2026-07-22", key: "42", label: "大吉", fortunePercent: 99 });
    route({ type: "verificationDelete", chatId: -1, userId: 42, generation: 1, revision: 4 });

    expect(handleLogMessage).toHaveBeenCalledTimes(1);
    expect(markAiMemorySnapshotDirty).toHaveBeenCalledWith(-1, 2, "memory");
    expect(deleteAiMemorySnapshot).toHaveBeenCalledWith(-1, 3);
    expect(markStickerCatalogSnapshotDirty).toHaveBeenCalledWith("pack", "catalog");
    expect(handleLuckDrawMessage).toHaveBeenCalledTimes(1);
    expect(handleVerificationDelete).toHaveBeenCalledTimes(1);
  });

  test("密钥请求总有显式成功或失败回执", () => {
    route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 8 });
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

  test("flush 不短路其它 owner，并按总体结果选择回执", () => {
    flushAiMemorySnapshots.mockReturnValueOnce(false);
    route({ type: "flush", flushId: 11 });

    for (const fn of [flushLogBuffer, flushAiMemorySnapshots, flushStickerCatalogs, flushLuckAppends, flushVerificationChanges]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushFailed", flushedId: 11 });
  });
});
