import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiskIOMessage } from "../../packages/types";

const handleLogMessage = mock((_message: unknown): void => {});
const markAiMemorySnapshotDirty = mock((_input: unknown): void => {});
const deleteAiMemorySnapshot = mock((_chatId: number, _revision: number): void => {});
const markStickerCatalogSnapshotDirty = mock((_pack: string, _snapshot: string): void => {});
const handleLuckDrawMessage = mock((_message: unknown): void => {});
const handleVerificationUpsert = mock((_input: unknown): void => {});
const handleVerificationDelete = mock((_input: unknown): void => {});
const handleJoinLogMessage = mock((_message: unknown): void => {});
const recoverJoinLogFiles = mock((_day: string): void => {});
const readJoinLog = mock((_message: unknown): readonly {
  userId: number;
  joinedAt: number;
}[] => [{ userId: 42, joinedAt: 1_000 }]);
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
const configureLuckAppendStalledReply = mock((_notify: (reply: unknown) => void): void => {});
const flushVerificationChanges = mock((_reply: (reply: unknown) => void): boolean => true);
const flushBlocklistRemovalOutbox = mock((): boolean => true);
const pendingStorageDatabaseDomains = mock((): readonly ["blocklistRemovalOutbox"] => [
  "blocklistRemovalOutbox",
]);
const flushJoinLogDomain = mock((): boolean => true);
const handleBlocklistRemovalsMessage = mock((_message: unknown): void => {});
const handleIdentityPolicyWrite = mock((_message: unknown): void => {});
const handleChatStateWrite = mock((_message: unknown): void => {});
const handleChatQaWrite = mock((_message: unknown): void => {});
const postMessage = mock((_reply: unknown): void => {});
const hydrateStickerCatalogs = mock((_packs: readonly string[]): Map<string, string> => new Map());
// Worker 重建时仍会自行复核贴纸白名单；运行期被改坏时恢复必须拒绝。
let stickerConfigFailure: string | null = null;
const consoleError = mock((..._args: unknown[]): void => {});

mock.module("../../packages/workers/diskIO/logFiles", () => ({
  flushLogBuffer,
  handleLogMessage,
  initLogFiles: (): void => {},
}));
mock.module("../../packages/workers/diskIO/luckFiles", () => ({
  configureLuckAppendStalledReply,
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
}));
mock.module("../../packages/workers/diskIO/luckSecretFile", () => ({ recoverLuckReceiptSecret }));
mock.module("../../packages/cache/workers/diskIO/luck", () => ({ luckWorkerCache }));
mock.module("../../packages/workers/diskIO/verificationRecovery", () => ({
  recoverVerificationDay: (): Map<string, unknown> => new Map(),
}));
mock.module("../../packages/workers/diskIO/verificationWrites", () => ({
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  scheduleVerificationRollover: (): void => {},
}));
mock.module("../../packages/workers/diskIO/joinLogFiles", () => ({
  flushJoinLogDomain,
  handleJoinLogMessage,
  readJoinLog,
  recoverJoinLogFiles,
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
mock.module("../../packages/workers/diskIO/storageDatabase", () => ({
  configureStoragePersistenceReply: (): void => {},
  flushStorageDatabase: flushBlocklistRemovalOutbox,
  handleIdentityPolicyWrite,
  handleChatStateWrite,
  handleChatQaWrite,
  handlePendingRemovalSnapshot: handleBlocklistRemovalsMessage,
  hydrateStorageDatabase: (): {
    blocklistEntryCount: number;
    whitelistEntryCount: number;
    pendingBlockedRemovals: Map<number, never>;
    chatStates: Map<number, never>;
    chatQa: Map<number, never>;
  } => ({
    blocklistEntryCount: 0,
    whitelistEntryCount: 0,
    pendingBlockedRemovals: new Map<number, never>(),
    chatStates: new Map<number, never>(),
    chatQa: new Map<number, never>(),
  }),
  pendingStorageDatabaseDomains,
  readBlocklistIdPage: (message: { requestId: number; afterId: number | null }): unknown => ({
    type: "blocklistIdPageRead",
    requestId: message.requestId,
    page: { ids: [], nextCursor: message.afterId, done: true },
  }),
  readIdentityPolicies: (message: { requestId: number }): unknown => ({
    type: "identityPoliciesRead",
    requestId: message.requestId,
    whitelist: [],
    blocklist: [],
  }),
}));

const workerGlobal = globalThis as typeof globalThis & { postMessage: (message: unknown) => void };
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = postMessage;
const { handleDiskIOWorkerMessage } = await import("../../packages/workers/diskIOWorker");
// 拒收标记走真实的 owner 缓存：路由层的兜底就是靠它把失败传给统一 flush。
const { consumeJoinLogRejection } = await import("../../packages/cache/workers/diskIO/joinLog");
const {
  rejectedStorageDomains,
} = await import("../../packages/cache/workers/diskIO/storageDatabase");
const { resetDiskIOReplayWindow } = await import("../../packages/cache/workers/diskIO/recovery");

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
    handleJoinLogMessage,
    recoverJoinLogFiles,
    readJoinLog,
    flushLogBuffer,
    flushAiMemorySnapshots,
    flushStickerCatalogs,
    flushLuckAppends,
    flushVerificationChanges,
    flushBlocklistRemovalOutbox,
    pendingStorageDatabaseDomains,
    flushJoinLogDomain,
    handleBlocklistRemovalsMessage,
    handleIdentityPolicyWrite,
    handleChatStateWrite,
    handleChatStateWrite,
    postMessage,
    hydrateLuckDay,
    hydrateStickerCatalogs,
    consoleError,
  ]) fn.mockClear();
  // 重放窗口是 Worker 独占的模块级状态：某个用例遗留的 true 会让后面每一次
  // 写失败都误报成停机回执。
  resetDiskIOReplayWindow();
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
  flushJoinLogDomain.mockReturnValue(true);
  readJoinLog.mockImplementation(() => [{ userId: 42, joinedAt: 1_000 }]);
});

function route(message: DiskIOMessage): void {
  handleDiskIOWorkerMessage(message);
}

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", () => {
    route({
      type: "diagnosticBatch",
      batchId: 7,
      messages: [{ type: "log", timestamp: 1, level: "error", args: ["boom"] }],
    });
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
    route({ type: "blocklistRemovals", revision: 1, removals: [] });
    route({
      type: "joinLog",
      chatId: -1,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
    });

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
    expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: "diagnosticBatchAccepted",
      batchId: 7,
    });
  });

  test("日志批次刷盘失败时要求主线程保留原批并按退避窗口重发", () => {
    flushLogBuffer.mockReturnValueOnce(false);

    route({
      type: "diagnosticBatch",
      batchId: 9,
      messages: [{ type: "log", timestamp: 1, level: "error", args: ["retry"] }],
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: "diagnosticBatchRetry",
      batchId: 9,
      retryAfterMs: 300_000,
    });
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "diagnosticBatchAccepted",
    }));
  });

  test("身份 SQLite 的两个 owner 抛错同样不逸出 onmessage，按领域记拒收", () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("Identity 7 cannot exist in both whitelist_entries and blocklist_entries.");
    });
    handleBlocklistRemovalsMessage.mockImplementationOnce((): void => {
      throw new Error("Pending removal row 1 contains an identity absent from the effective blocklist.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 校验失败此前是裸抛：异常离开 onmessage 后 Bun 直接终止整条落盘线程，
      // 九个领域的缓冲随线程一起没了，反复触发还会顶到重启节流停掉整个进程。
      expect((): void => route({
        type: "identityPolicyWrite",
        table: "whitelist",
        id: 7,
        data: null,
        revision: 1,
      })).not.toThrow();
      expect((): void => route({
        type: "blocklistRemovals",
        revision: 1,
        removals: [],
      })).not.toThrow();
    } finally {
      console.error = originalConsoleError;
    }

    expect(consoleError).toHaveBeenCalledTimes(2);
    // 主线程只能靠下一次领域 flush 的失败回执才知道这条最终值没落盘——
    // /block 的 confirmBlocklistPersisted 正是这么问的。
    expect([...rejectedStorageDomains].sort()).toEqual([
      "blocklistRemovalOutbox",
      "whitelist",
    ]);
    // 在线消息不升级为停机：主线程仍持有未 ACK 的 revision，Worker 重建时重放。
    expect(postMessage).not.toHaveBeenCalled();
    rejectedStorageDomains.clear();
  });

  test("恢复重放期间的身份写失败升级为停机回执，不只是记拒收", () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("revision must be a positive safe integer.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      route({ type: "recoveryReplay", active: true });
      route({
        type: "identityPolicyWrite",
        table: "blocklist",
        id: 7,
        data: null,
        revision: 1,
      });
      route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    // 重放的这条对应的 update 早已被确认过，后面不会再有 flush 来问它。
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "blocklist",
    }));
    rejectedStorageDomains.clear();
  });

  test("入群事实的 owner 抛错不逸出 onmessage，改记拒收让统一 flush 回报失败", () => {
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 逸出 onmessage 的异常会被 Bun 直接终止整条落盘线程：在途 flush 全按失败
      // 结算、各领域缓冲随线程一起没了，反复触发还会把整个进程停掉。
      expect((): void => route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).not.toThrow();
    } finally {
      console.error = originalConsoleError;
    }
    expect(consoleError).toHaveBeenCalledTimes(1);
    // 代价只落在 joinLog 这一个领域：拒收标记让 recordJoinLog 紧接着那次
    // flush 拿到 flushFailed，该 update 不被确认，Telegram 重投。
    expect(consumeJoinLogRejection()).toBeTrue();
    // 在线消息不升级为停机：它后面紧跟着调用方自己的 flush。
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("恢复缓冲重放期间的入群写失败升级为停机回执，不只是记拒收", () => {
    // 重放的这条在崩溃窗口里就已经被 recordJoinLog 放行、update 也确认过了，
    // 后面没有任何 flush 会再问它写没写进去。只记拒收的话，标记会挂到某个无关的
    // 后续入群事实那次 flush 上——那一条被连坐重投，真正丢掉的这一条毫无痕迹。
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Join log buffer reached its hard limit of 4096 entries.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      route({ type: "recoveryReplay", active: true });
      expect((): void => route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).not.toThrow();
      route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "recoveryReplayFailed",
      domain: "joinLog",
      error: "Join log buffer reached its hard limit of 4096 entries.",
    });
    // 拒收标记照记不误：停机路径与领域内的回报互不取代。
    expect(consumeJoinLogRejection()).toBeTrue();
  });

  test("重放窗口关闭后写失败回到常规语义，不再升级为停机", () => {
    route({ type: "recoveryReplay", active: true });
    route({ type: "recoveryReplay", active: false });
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      route({ type: "joinLog", chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01" });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).not.toHaveBeenCalled();
    expect(consumeJoinLogRejection()).toBeTrue();
  });

  test("入群日志查询总有显式成功或失败回执", () => {
    route({
      type: "readJoinLog",
      requestId: 15,
      chatId: -1,
      since: 1,
      now: 1_000,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "joinLogRead",
      requestId: 15,
      records: [{ userId: 42, joinedAt: 1_000 }],
    });

    readJoinLog.mockImplementationOnce(() => {
      throw new Error("corrupt join log");
    });
    route({
      type: "readJoinLog",
      requestId: 16,
      chatId: -1,
      since: 1,
      now: 1_000,
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "joinLogRead",
      requestId: 16,
      error: "corrupt join log",
    });
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

  test("贴纸白名单写坏时拒绝启动恢复，不进入状态对账或后续 owner", () => {
    stickerConfigFailure = "config/stickers.json: $.packs must be an array.";
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      route({ type: "load" });
    } finally {
      console.error = originalConsoleError;
    }

    expect(hydrateStickerCatalogs).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(hydrateLuckDay).not.toHaveBeenCalled();
    expect(recoverJoinLogFiles).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: "config/stickers.json: $.packs must be an array.",
    }));
  });

  test("白名单可读时原样传下去，孤儿清理照常生效", () => {
    route({ type: "load" });

    expect(hydrateStickerCatalogs).toHaveBeenCalledWith(["pack_a"]);
    expect(recoverJoinLogFiles).toHaveBeenCalledTimes(1);
  });

  test("flush 不短路其它 owner，并按领域回报失败", () => {
    flushAiMemorySnapshots.mockReturnValueOnce(false);
    route({ type: "flush", flushId: 11, scope: "all" });

    for (const fn of [
      flushLogBuffer,
      flushAiMemorySnapshots,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogDomain,
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
    route({ type: "flush", flushId: 12, scope: "all" });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 12,
      failedDomains: ["blocklistRemovalOutbox"],
    });
  });

  test("诊断重建前的 business flush 跳过故障日志，但完整刷完全部权威业务领域", () => {
    route({ type: "flush", flushId: 13, scope: "business" });

    expect(flushLogBuffer).not.toHaveBeenCalled();
    for (const fn of [
      flushAiMemorySnapshots,
      flushStickerCatalogs,
      flushLuckAppends,
      flushVerificationChanges,
      flushBlocklistRemovalOutbox,
      flushJoinLogDomain,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 13 });
  });

  test("九个领域全部成功时回执不带失败领域", () => {
    route({ type: "flush", flushId: 14, scope: "all" });

    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 14 });
  });
});
