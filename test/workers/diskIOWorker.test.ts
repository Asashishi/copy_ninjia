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
const inspectLogFiles = mock((): { readonly kind: "logs" } => ({ kind: "logs" }));
const adoptLogFiles = mock((_inspection: unknown): void => {});
const maintainLogFiles = mock(async (_inspection: unknown): Promise<void> => {});
const maintainLogRetention = mock((): void => {});
const inspectAiMemorySnapshots = mock((): { readonly kind: "ai" } => ({ kind: "ai" }));
const adoptAiMemorySnapshots = mock((_inspection: unknown): Map<number, string> => new Map());
const maintainAiMemorySnapshots = mock((_inspection: unknown): void => {});
interface StickerInspection {
  readonly kind: "stickers";
}
const inspectStickerCatalogSnapshots = mock(async (
  _packs: readonly string[]
): Promise<StickerInspection> => ({ kind: "stickers" }));
const adoptStickerCatalogSnapshots = mock((_inspection: unknown): Map<string, string> => new Map());
const maintainStickerCatalogSnapshots = mock((_inspection: unknown): void => {});
const inspectJoinLogFiles = mock((day: string): { readonly today: string } => ({ today: day }));
const maintainJoinLogFiles = mock((_inspection: unknown): void => {});
const maintainJoinLogRetention = mock((_day?: string): void => {});
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
const inspectLuckDayState = mock((day: string): {
  readonly day: string;
  readonly cache: { readonly day: string; readonly entries: HydratedLuckEntries };
} => ({ day, cache: { day, entries: new Map(hydratedLuckEntries) } }));
const adoptLuckDay = mock((inspection: {
  readonly cache: { day: string; entries: HydratedLuckEntries };
}): void => { luckWorkerCache.current = inspection.cache; });
const maintainLuckDayState = mock((_day: string, _inspection: unknown): void => {});
const maintainLuckForDay = mock((_day: string): void => {});
const inspectLuckReceiptSecret = mock((input: LuckSecretRecoveryInput): {
  readonly day: string;
  readonly path: string;
  readonly secret: null;
} => ({ day: input.day, path: "receipt-secret.json", secret: null }));
const adoptLuckReceiptSecret = mock((inspection: { readonly day: string }): {
  version: 1;
  day: string;
  key: string;
} => ({ version: 1, day: inspection.day, key: "secret" }));
const inspectVerificationDay = mock((day: string): { readonly day: string } => ({ day }));
const adoptVerificationDay = mock((_inspection: unknown): Map<string, unknown> => new Map());
const maintainVerificationDay = mock((_inspection: unknown): void => {});
const flushLogBuffer = mock((): boolean => true);
const flushAiMemorySnapshots = mock((): boolean => true);
const flushStickerCatalogs = mock((): boolean => true);
const flushLuckAppends = mock((): boolean => true);
const configureLuckAppendStalledReply = mock((_notify: (reply: unknown) => void): void => {});
const flushVerificationChanges = mock((_reply: (reply: unknown) => void): boolean => true);
const maintainVerificationDayForToday = mock((
  _reply: (reply: unknown) => void,
  _day?: string
): void => {});
const maintainAdSampleFiles = mock((_today?: string): void => {});
const maintainTemporaryWhitelistActivities = mock((_reply: unknown, _now?: number): void => {});
const flushBlocklistRemovalOutbox = mock((): boolean => true);
const pendingStorageDatabaseDomains = mock((): readonly ["blocklistRemovalOutbox"] => [
  "blocklistRemovalOutbox",
]);
const flushJoinLogDomain = mock((): boolean => true);
const handleBlocklistRemovalsMessage = mock((_message: unknown): void => {});
const handleIdentityPolicyWrite = mock((_message: unknown): void => {});
const handleChatStateWrite = mock((_message: unknown): void => {});
const handleChatQaWrite = mock((_message: unknown): void => {});
const handleTemporaryWhitelistWrite = mock((_message: unknown): void => {});
const postMessage = mock((_reply: unknown): void => {});
const consoleError = mock((..._args: unknown[]): void => {});
interface HydratedStorageDatabase {
  readonly blocklistEntryCount: number;
  readonly whitelistEntryCount: number;
  readonly pendingBlockedRemovals: Map<number, never>;
  readonly chatStates: Map<number, never>;
  readonly chatQa: Map<number, never>;
}
const inspectStorageDatabase = mock((): { readonly kind: "storage" } => ({ kind: "storage" }));
const adoptStorageDatabase = mock((_inspection: unknown): HydratedStorageDatabase => ({
  blocklistEntryCount: 0,
  whitelistEntryCount: 0,
  pendingBlockedRemovals: new Map<number, never>(),
  chatStates: new Map<number, never>(),
  chatQa: new Map<number, never>(),
}));

mock.module("../../packages/workers/diskIO/logFiles", () => ({
  adoptLogFiles,
  flushLogBuffer,
  handleLogMessage,
  inspectLogFiles,
  maintainLogFiles,
  maintainLogRetention,
}));
mock.module("../../packages/workers/diskIO/luckFiles", () => ({
  adoptLuckDay,
  configureLuckAppendStalledReply,
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
  inspectLuckDayState,
  maintainLuckDayState,
  maintainLuckForDay,
}));
mock.module("../../packages/workers/diskIO/luckSecretFile", () => ({
  adoptLuckReceiptSecret,
  inspectLuckReceiptSecret,
  recoverLuckReceiptSecret,
}));
mock.module("../../packages/cache/workers/diskIO/luck", () => ({ luckWorkerCache }));
mock.module("../../packages/workers/diskIO/verificationRecovery", () => ({
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
}));
mock.module("../../packages/workers/diskIO/verificationWrites", () => ({
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  maintainVerificationDayForToday,
}));
mock.module("../../packages/workers/diskIO/adSampleFile", () => ({
  handleAdSampleMessage: (_message: unknown): void => {},
  maintainAdSampleFiles,
}));
mock.module("../../packages/workers/diskIO/joinLogFiles", () => ({
  flushJoinLogDomain,
  handleJoinLogMessage,
  inspectJoinLogFiles,
  maintainJoinLogFiles,
  maintainJoinLogRetention,
  readJoinLog,
}));
mock.module("../../packages/workers/diskIO/aiMemoryFiles", () => ({
  adoptAiMemorySnapshots,
  configureAiMemoryDeletePersistedReply: (): void => {},
  configureAiMemoryPersistedReply: (): void => {},
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,
  inspectAiMemorySnapshots,
  maintainAiMemorySnapshots,
  markAiMemorySnapshotDirty,
}));
mock.module("../../packages/workers/diskIO/stickerCatalogFiles", () => ({
  adoptStickerCatalogSnapshots,
  flushStickerCatalogs,
  inspectStickerCatalogSnapshots,
  maintainStickerCatalogSnapshots,
  markStickerCatalogSnapshotDirty,
}));
mock.module("../../packages/workers/diskIO/storageDatabase", () => ({
  adoptStorageDatabase,
  configureStoragePersistenceReply: (): void => {},
  flushStorageDatabase: flushBlocklistRemovalOutbox,
  handleIdentityPolicyWrite,
  handleChatStateWrite,
  handleChatQaWrite,
  handleTemporaryWhitelistWrite,
  handlePendingRemovalSnapshot: handleBlocklistRemovalsMessage,
  inspectStorageDatabase,
  pendingStorageDatabaseDomains,
  maintainTemporaryWhitelistActivities,
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
    temporaryWhitelist: [],
  }),
}));
const workerGlobal = globalThis as typeof globalThis & { postMessage: (message: unknown) => void };
const originalPostMessage = workerGlobal.postMessage;
workerGlobal.postMessage = postMessage;
const {
  handleDiskIOWorkerMessage,
  queueDiskIOWorkerMessage,
} = await import("../../packages/workers/diskIOWorker");
const { diskIOMaintenanceCron } = await import(
  "../../packages/cache/workers/diskIO/maintenance"
);
const { stopDiskIOMaintenanceCron } = await import(
  "../../packages/workers/diskIO/maintenanceCron"
);
// 拒收标记走真实的 owner 缓存：路由层的兜底就是靠它把失败传给统一 flush。
const { consumeJoinLogRejection } = await import("../../packages/cache/workers/diskIO/joinLog");
const {
  rejectedStorageDomains,
} = await import("../../packages/cache/workers/diskIO/storageDatabase");
const {
  diskIOOperationTail,
  resetDiskIOReplayWindow,
} = await import("../../packages/cache/workers/diskIO/recovery");

afterAll(() => {
  stopDiskIOMaintenanceCron();
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
    inspectLogFiles,
    adoptLogFiles,
    maintainLogFiles,
    maintainLogRetention,
    inspectAiMemorySnapshots,
    adoptAiMemorySnapshots,
    maintainAiMemorySnapshots,
    inspectStickerCatalogSnapshots,
    adoptStickerCatalogSnapshots,
    maintainStickerCatalogSnapshots,
    inspectJoinLogFiles,
    maintainJoinLogFiles,
    maintainJoinLogRetention,
    readJoinLog,
    flushLogBuffer,
    flushAiMemorySnapshots,
    flushStickerCatalogs,
    flushLuckAppends,
    flushVerificationChanges,
    maintainVerificationDayForToday,
    maintainAdSampleFiles,
    maintainTemporaryWhitelistActivities,
    flushBlocklistRemovalOutbox,
    pendingStorageDatabaseDomains,
    flushJoinLogDomain,
    handleBlocklistRemovalsMessage,
    handleIdentityPolicyWrite,
    handleChatStateWrite,
    handleChatQaWrite,
    handleTemporaryWhitelistWrite,
    postMessage,
    hydrateLuckDay,
    inspectLuckDayState,
    adoptLuckDay,
    maintainLuckDayState,
    maintainLuckForDay,
    inspectLuckReceiptSecret,
    adoptLuckReceiptSecret,
    inspectVerificationDay,
    adoptVerificationDay,
    maintainVerificationDay,
    consoleError,
    inspectStorageDatabase,
    adoptStorageDatabase,
  ]) fn.mockClear();
  // 重放窗口是 Worker 独占的模块级状态：某个用例遗留的 true 会让后面每一次
  // 写失败都误报成停机回执。
  resetDiskIOReplayWindow();
  diskIOOperationTail.current = Promise.resolve();
  luckWorkerCache.current = null;
  hydratedLuckEntries = new Map();
  recoverLuckReceiptSecret.mockReset();
  recoverLuckReceiptSecret.mockImplementation((input) => ({ version: 1, day: input.day, key: "secret" }));
  adoptStorageDatabase.mockImplementation((): HydratedStorageDatabase => ({
    blocklistEntryCount: 0,
    whitelistEntryCount: 0,
    pendingBlockedRemovals: new Map<number, never>(),
    chatStates: new Map<number, never>(),
    chatQa: new Map<number, never>(),
  }));
  flushLogBuffer.mockReturnValue(true);
  flushAiMemorySnapshots.mockReturnValue(true);
  flushStickerCatalogs.mockReturnValue(true);
  flushLuckAppends.mockReturnValue(true);
  flushVerificationChanges.mockReturnValue(true);
  flushBlocklistRemovalOutbox.mockReturnValue(true);
  flushJoinLogDomain.mockReturnValue(true);
  readJoinLog.mockImplementation(() => [{ userId: 42, joinedAt: 1_000 }]);
});

async function route(message: DiskIOMessage): Promise<void> {
  await handleDiskIOWorkerMessage(message);
}

describe("Disk I/O Worker protocol router", () => {
  test("把各业务消息准确交给唯一领域 owner", async () => {
    await route({
      type: "diagnosticBatch",
      batchId: 7,
      messages: [{ type: "log", timestamp: 1, level: "error", args: ["boom"] }],
    });
    await route({
      type: "aiMemory",
      chatId: -1,
      revision: 2,
      snapshot: "memory",
      persistImmediately: true,
    });
    await route({ type: "deleteAiMemory", chatId: -1, revision: 3 });
    await route({ type: "stickerCatalog", pack: "pack", snapshot: "catalog" });
    await route({ type: "luckDraw", day: "2026-07-22", key: "42", label: "大吉", fortunePercent: 99 });
    await route({ type: "verificationDelete", chatId: -1, userId: 42, generation: 1, revision: 4 });
    await route({ type: "blocklistRemovals", revision: 1, removals: [] });
    await route({
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

  test("日志批次刷盘失败时要求主线程保留原批并按退避窗口重发", async () => {
    flushLogBuffer.mockReturnValueOnce(false);

    await route({
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

  test("身份 SQLite 的三个 owner 抛错同样不逸出 onmessage，按领域记拒收", async () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("Identity 7 cannot exist in both whitelist_entries and blocklist_entries.");
    });
    handleBlocklistRemovalsMessage.mockImplementationOnce((): void => {
      throw new Error("Pending removal row 1 contains an identity absent from the effective blocklist.");
    });
    handleTemporaryWhitelistWrite.mockImplementationOnce((): void => {
      throw new Error("Temporary whitelist activity is invalid.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 校验失败必须留在当前消息边界内；异常离开 onmessage 会让 Bun 终止落盘线程，
      // 连带丢失各领域的进程内缓冲并触发重启节流。
      await expect(route({
        type: "identityPolicyWrite",
        table: "whitelist",
        id: 7,
        data: null,
        revision: 1,
      })).resolves.toBeUndefined();
      await expect(route({
        type: "blocklistRemovals",
        revision: 1,
        removals: [],
      })).resolves.toBeUndefined();
      await expect(route({
        type: "temporaryWhitelistWrite",
        id: 8,
        activity: null,
        revision: 1,
      })).resolves.toBeUndefined();
    } finally {
      console.error = originalConsoleError;
    }

    expect(consoleError).toHaveBeenCalledTimes(3);
    // 主线程只能靠下一次领域 flush 的失败回执才知道这条最终值没落盘——
    // /block 的 confirmBlocklistPersisted 正是这么问的。
    expect([...rejectedStorageDomains].sort()).toEqual([
      "blocklistRemovalOutbox",
      "temporaryWhitelist",
      "whitelist",
    ]);
    // 在线消息不升级为停机：主线程仍持有未 ACK 的 revision，Worker 重建时重放。
    expect(postMessage).not.toHaveBeenCalled();
    rejectedStorageDomains.clear();
  });

  test("恢复重放期间的身份写失败升级为停机回执，不只是记拒收", async () => {
    handleIdentityPolicyWrite.mockImplementationOnce((): void => {
      throw new Error("revision must be a positive safe integer.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "recoveryReplay", active: true });
      await route({
        type: "identityPolicyWrite",
        table: "blocklist",
        id: 7,
        data: null,
        revision: 1,
      });
      await route({ type: "recoveryReplay", active: false });
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

  test("群状态与问答在线拒收只标记各自领域，恢复重放时升级为 fatal", async () => {
    for (let attempt: number = 0; attempt < 2; attempt += 1) {
      handleChatStateWrite.mockImplementationOnce((): void => {
        throw new Error("chat state write rejected");
      });
      handleChatQaWrite.mockImplementationOnce((): void => {
        throw new Error("chat QA write rejected");
      });
    }
    const stateMessage: DiskIOMessage = {
      type: "chatStateWrite",
      chatId: -1,
      data: "{}",
      revision: 1,
    };
    const qaMessage: DiskIOMessage = {
      type: "chatQaWrite",
      chatId: -1,
      q: "question",
      data: "answer",
      revision: 1,
    };
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route(stateMessage);
      await route(qaMessage);
      expect([...rejectedStorageDomains].sort()).toEqual(["chatQa", "chatState"]);
      expect(postMessage).not.toHaveBeenCalled();

      rejectedStorageDomains.clear();
      await route({ type: "recoveryReplay", active: true });
      await route(stateMessage);
      await route(qaMessage);
      await route({ type: "recoveryReplay", active: false });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "chatState",
      error: "chat state write rejected",
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "recoveryReplayFailed",
      domain: "chatQa",
      error: "chat QA write rejected",
    }));
    rejectedStorageDomains.clear();
  });

  test("入群事实的 owner 抛错不逸出 onmessage，改记拒收让统一 flush 回报失败", async () => {
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      // 逸出 onmessage 的异常会被 Bun 直接终止整条落盘线程：在途 flush 全按失败
      // 结算、各领域缓冲随线程一起没了，反复触发还会把整个进程停掉。
      await expect(route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).resolves.toBeUndefined();
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

  test("恢复缓冲重放期间的入群写失败升级为停机回执，不只是记拒收", async () => {
    // 重放的这条在崩溃窗口里就已经被 recordJoinLog 放行、update 也确认过了，
    // 后面没有任何 flush 会再问它写没写进去。只记拒收的话，标记会挂到某个无关的
    // 后续入群事实那次 flush 上——那一条被连坐重投，真正丢掉的这一条毫无痕迹。
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Join log buffer reached its hard limit of 4096 entries.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "recoveryReplay", active: true });
      await expect(route({
        type: "joinLog",
        chatId: -1,
        userId: 42,
        joinedAt: 1_000,
        day: "1970-01-01",
      })).resolves.toBeUndefined();
      await route({ type: "recoveryReplay", active: false });
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

  test("重放窗口关闭后写失败回到常规语义，不再升级为停机", async () => {
    await route({ type: "recoveryReplay", active: true });
    await route({ type: "recoveryReplay", active: false });
    handleJoinLogMessage.mockImplementationOnce((): void => {
      throw new Error("Failed to flush join logs before day rollover cleanup.");
    });

    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "joinLog", chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01" });
    } finally {
      console.error = originalConsoleError;
    }

    expect(postMessage).not.toHaveBeenCalled();
    expect(consumeJoinLogRejection()).toBeTrue();
  });

  test("入群日志查询总有显式成功或失败回执", async () => {
    await route({
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
    await route({
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

  test("密钥请求总有显式成功或失败回执", async () => {
    hydratedLuckEntries.set("confirmed", { label: "大吉", fortunePercent: 99 });
    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 8 });
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
    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 9 });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 9,
      error: "corrupt secret",
    });
  });

  test("跨日密钥请求先提交旧日追加缓冲，刷盘失败时不切换 owner", async () => {
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };

    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 10 });

    expect(flushLuckAppends).toHaveBeenCalledTimes(1);
    expect(hydrateLuckDay).toHaveBeenCalledWith("2026-07-22");
    expect(flushLuckAppends.mock.invocationCallOrder[0]).toBeLessThan(hydrateLuckDay.mock.invocationCallOrder[0]!);

    flushLuckAppends.mockClear();
    hydrateLuckDay.mockClear();
    recoverLuckReceiptSecret.mockClear();
    postMessage.mockClear();
    luckWorkerCache.current = { day: "2026-07-21", entries: new Map() };
    flushLuckAppends.mockReturnValueOnce(false);

    await route({ type: "ensureLuckSecret", day: "2026-07-22", requestId: 11 });

    expect(hydrateLuckDay).not.toHaveBeenCalled();
    expect(recoverLuckReceiptSecret).not.toHaveBeenCalled();
    expect(luckWorkerCache.current.day).toBe("2026-07-21");
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "luckSecret",
      requestId: 11,
      error: "Failed to flush luck results before switching from 2026-07-21 to 2026-07-22.",
    });
  });

  test("启动恢复先加载当天结果，再把确认数交给密钥一致性检查", async () => {
    hydratedLuckEntries.set("confirmed", { label: "大吉", fortunePercent: 99 });

    await route({ type: "load", stickerPacks: ["pack_a"] });

    expect(inspectLuckDayState).toHaveBeenCalledTimes(1);
    expect(inspectLuckReceiptSecret).toHaveBeenLastCalledWith({
      day: expect.any(String),
      confirmedResultCount: 1,
    });
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      luckReceiptSecret: expect.objectContaining({ key: "secret" }),
      error: undefined,
    }));
  });

  test("主线程已校验的贴纸白名单快照原样用于恢复 inspect", async () => {
    await route({ type: "load", stickerPacks: ["pack_b"] });

    expect(inspectStickerCatalogSnapshots).toHaveBeenCalledWith(["pack_b"]);
  });

  test("白名单可读时先只读 inspect，成功回执后才执行孤儿维护", async () => {
    await route({ type: "load", stickerPacks: ["pack_a"] });

    expect(inspectStickerCatalogSnapshots).toHaveBeenCalledWith(["pack_a"]);
    expect(inspectJoinLogFiles).toHaveBeenCalledTimes(1);
    expect(adoptStickerCatalogSnapshots).toHaveBeenCalledTimes(1);
    expect(maintainStickerCatalogSnapshots).toHaveBeenCalledTimes(1);
    expect(maintainAdSampleFiles).toHaveBeenCalledTimes(1);
    expect(maintainTemporaryWhitelistActivities).toHaveBeenCalledTimes(1);
    expect(diskIOMaintenanceCron.current).not.toBeNull();
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      maintainStickerCatalogSnapshots.mock.invocationCallOrder[0]!
    );
  });

  test("load 未完成时后续业务写只排队，不得穿过恢复事务", async () => {
    let releaseInspection: ((inspection: StickerInspection) => void) | null = null;
    inspectStickerCatalogSnapshots.mockImplementationOnce(
      (_packs: readonly string[]): Promise<StickerInspection> => new Promise<StickerInspection>(
        (resolve: (inspection: StickerInspection) => void): void => {
          releaseInspection = resolve;
        }
      )
    );

    const load: Promise<void> = queueDiskIOWorkerMessage({
      type: "load",
      stickerPacks: ["pack_a"],
    });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog",
      chatId: -1,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
    });
    await Bun.sleep(0);

    expect(inspectStickerCatalogSnapshots).toHaveBeenCalledTimes(1);
    expect(handleJoinLogMessage).not.toHaveBeenCalled();
    expect(releaseInspection).not.toBeNull();
    releaseInspection!({ kind: "stickers" });
    await load;
    await write;

    expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      handleJoinLogMessage.mock.invocationCallOrder[0]!
    );
  });

  test("loaded 已回执但异步维护未完成时，后续写入仍等待且 cron 尚未注册", async () => {
    const entered = Promise.withResolvers<void>();
    const maintenance = Promise.withResolvers<void>();
    maintainLogFiles.mockImplementationOnce(async (): Promise<void> => {
      entered.resolve();
      await maintenance.promise;
    });
    const load: Promise<void> = queueDiskIOWorkerMessage({ type: "load", stickerPacks: [] });
    const write: Promise<void> = queueDiskIOWorkerMessage({
      type: "joinLog", chatId: -1, userId: 42, joinedAt: 1_000, day: "1970-01-01",
    });
    try {
      await entered.promise;
      expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: "loaded" }));
      expect(maintainAiMemorySnapshots).not.toHaveBeenCalled();
      expect(handleJoinLogMessage).not.toHaveBeenCalled();
      expect(diskIOMaintenanceCron.current).toBeNull();
      maintenance.resolve();
      await load;
      await write;
      expect(maintainAiMemorySnapshots).toHaveBeenCalledTimes(1);
      expect(handleJoinLogMessage).toHaveBeenCalledTimes(1);
      expect(diskIOMaintenanceCron.current).not.toBeNull();
    } finally {
      maintenance.resolve();
      await write;
    }
  });

  test("任一异步内容 inspect 失败时不 adopt、不维护其它领域", async () => {
    inspectStickerCatalogSnapshots.mockImplementationOnce(
      async (): Promise<StickerInspection> => {
        throw new Error("memory/sticker_catalog: $ must be readable valid JSON snapshots.");
      }
    );
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "load", stickerPacks: ["pack_a"] });
    } finally {
      console.error = originalConsoleError;
    }

    expect(adoptLogFiles).not.toHaveBeenCalled();
    expect(adoptAiMemorySnapshots).not.toHaveBeenCalled();
    expect(adoptStickerCatalogSnapshots).not.toHaveBeenCalled();
    expect(adoptLuckDay).not.toHaveBeenCalled();
    expect(adoptVerificationDay).not.toHaveBeenCalled();
    expect(adoptStorageDatabase).not.toHaveBeenCalled();
    expect(maintainLogFiles).not.toHaveBeenCalled();
    expect(maintainAiMemorySnapshots).not.toHaveBeenCalled();
    expect(maintainStickerCatalogSnapshots).not.toHaveBeenCalled();
    expect(maintainAdSampleFiles).not.toHaveBeenCalled();
    expect(diskIOMaintenanceCron.current).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: "memory/sticker_catalog: $ must be readable valid JSON snapshots.",
    }));
  });

  test("最后一个 SQLite inspect 失败时不 adopt、不维护也不注册 cron", async () => {
    inspectStorageDatabase.mockImplementationOnce((): { readonly kind: "storage" } => {
      throw new Error("database/storage.sqlite: $.schema must be the current schema.");
    });
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
    try {
      await route({ type: "load", stickerPacks: ["pack_a"] });
    } finally {
      console.error = originalConsoleError;
    }

    expect(adoptStorageDatabase).not.toHaveBeenCalled();
    expect(adoptLogFiles).not.toHaveBeenCalled();
    expect(maintainLogFiles).not.toHaveBeenCalled();
    expect(maintainAiMemorySnapshots).not.toHaveBeenCalled();
    expect(maintainStickerCatalogSnapshots).not.toHaveBeenCalled();
    expect(maintainJoinLogFiles).not.toHaveBeenCalled();
    expect(maintainLuckDayState).not.toHaveBeenCalled();
    expect(maintainVerificationDay).not.toHaveBeenCalled();
    expect(maintainAdSampleFiles).not.toHaveBeenCalled();
    expect(maintainTemporaryWhitelistActivities).not.toHaveBeenCalled();
    expect(diskIOMaintenanceCron.current).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "loaded",
      error: "database/storage.sqlite: $.schema must be the current schema.",
    }));
  });

  test("flush 不短路其它 owner，并按领域回报失败", async () => {
    flushAiMemorySnapshots.mockReturnValueOnce(false);
    await route({ type: "flush", flushId: 11, scope: "all" });

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
    await route({ type: "flush", flushId: 12, scope: "all" });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "flushFailed",
      flushedId: 12,
      failedDomains: ["blocklistRemovalOutbox"],
    });
  });

  test("诊断重建前的 business flush 跳过故障日志，但完整刷完全部权威业务领域", async () => {
    await route({ type: "flush", flushId: 13, scope: "business" });

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

  test("各领域全部成功时回执不带失败领域", async () => {
    await route({ type: "flush", flushId: 14, scope: "all" });

    expect(postMessage).toHaveBeenLastCalledWith({ type: "flushed", flushedId: 14 });
  });
});
