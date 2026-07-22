import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApplicationLifecycleDependencies } from "../../src/types/lifecycle";

const calls: string[] = [];
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const acquireSingleInstanceLock = mock(async (): Promise<void> => { calls.push("acquireLock"); });
const releaseSingleInstanceLock = mock(async (): Promise<void> => { calls.push("releaseLock"); });
const getStickerConfig = mock((): object => ({}));
const getReactionConfig = mock((): object => ({}));
const getMoodConfig = mock((): object => ({}));
const initTelegramClients = mock((): void => { calls.push("initTelegram"); });
let diskIOFatalHandler: ((error: Error) => void) | undefined;
const initDiskIO = mock((options?: { onFatal?: (error: Error) => void }): void => {
  calls.push("initDiskIO");
  diskIOFatalHandler = options?.onFatal;
});
const cleanupOrphanedTempFiles = mock(async (): Promise<void> => { calls.push("cleanupTemps"); });
const loadState = mock(async (): Promise<void> => { calls.push("loadState"); });
const refreshAllChatTitles = mock(async (): Promise<void> => { calls.push("refreshTitles"); });
const loadPersistedData = mock(async () => ({
  aiMemories: new Map<number, string>(),
  stickerCatalogs: new Map<string, string>(),
  luckDay: null,
  luckReceiptSecret: { day: "2026-07-19", secret: "test-secret" },
  verifications: new Map<string, never>(),
}));
type FlushResult = "flushed" | "timedOut" | "failed";
const flushDiskIO = mock(async (): Promise<FlushResult> => { calls.push("flushDiskIO"); return "flushed"; });
const flushStateToDisk = mock(async (): Promise<FlushResult> => { calls.push("flushState"); return "flushed"; });
const flushAiMemory = mock(async (): Promise<FlushResult> => { calls.push("flushAiMemory"); return "flushed"; });
const terminateDiskIO = mock(async (): Promise<void> => { calls.push("terminateDiskIO"); });
const terminateAiChat = mock(async (): Promise<void> => { calls.push("terminateAiChat"); });
const terminateAntiRaid = mock(async (): Promise<void> => { calls.push("terminateAntiRaid"); });
const drainAntiRaid = mock(async (): Promise<FlushResult> => { calls.push("drainAntiRaid"); return "flushed"; });
const drainReactionQueue = mock(async (): Promise<FlushResult> => { calls.push("drainReaction"); return "flushed"; });
const drainAvatarUpdates = mock(async (): Promise<FlushResult> => { calls.push("drainAvatar"); return "flushed"; });
const drainTranslate = mock(async (): Promise<FlushResult> => { calls.push("drainTranslate"); return "flushed"; });
const closeTranslate = mock(async (): Promise<FlushResult> => { calls.push("closeTranslate"); return "flushed"; });
const initAvatarUpdates = mock((): void => { calls.push("initAvatar"); });
const initReactionQueue = mock((): void => { calls.push("initReaction"); });
const initChatTitleRefresh = mock((): void => { calls.push("initTitles"); });
const initTranslate = mock((): void => { calls.push("initTranslate"); });
const quiesceAvatarUpdates = mock((): void => { calls.push("quiesceAvatar"); });
const quiesceReactionQueue = mock((): void => { calls.push("quiesceReaction"); });
const quiesceChatTitleRefresh = mock((): void => { calls.push("quiesceTitles"); });
const quiesceTranslate = mock((): void => { calls.push("quiesceTranslate"); });
const abortChatTitleRefresh = mock((): void => { calls.push("abortTitles"); });
const hydrateAiMemory = mock((_value: unknown): void => { calls.push("hydrateAiMemory"); });
const hydrateStickerCatalog = mock((_value: unknown): void => { calls.push("hydrateStickerCatalog"); });
const initAiChat = mock((_value: unknown): void => { calls.push("initAiChat"); });
const hydratePendingVerifications = mock((_value: unknown): void => { calls.push("hydrateVerifications"); });
const initAntiRaid = mock((): void => { calls.push("initAntiRaid"); });
const restoreLuckState = mock((..._args: unknown[]): void => { calls.push("restoreLuck"); });
const seedSenderCache = mock((_value: unknown): void => { calls.push("seedSender"); });
const registerCommandMenu = mock(async (): Promise<void> => { calls.push("registerMenu"); });
let lastSeenUpdateId: number = 0;
const registerHandlers = mock(() => ({ getLastSeenUpdateId: (): number => lastSeenUpdateId }));
const getAllChatStates = mock(() => new Map<number, unknown>());
let copiedUser: object | null = null;
const getGlobalCopyState = mock(() => ({ copiedUser }));
const sleep = mock(async (): Promise<void> => {});
const setStatePersistenceFatalHandler = mock((_handler: ((error: Error) => void) | undefined): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const getUpdates = mock(async (): Promise<unknown[]> => { calls.push("getUpdates"); return []; });
const botInit = mock(async (): Promise<void> => { calls.push("botInit"); });
const bot = {
  botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot", is_bot: true },
  init: botInit,
  api: { getUpdates },
};

const runnerStop = mock(async (): Promise<void> => { calls.push("runnerStop"); });
const runnerTask = mock(async (): Promise<void> => {});
const runnerSize = mock((): number => 0);
const runnerHandle = { stop: runnerStop, task: runnerTask, size: runnerSize };
const runAcknowledgedUpdateBatches = mock((_bot: unknown, _updates: unknown) => {
  calls.push("runUpdates");
  return runnerHandle;
});

const testDependencies = {
  BOT_TOKEN: "test-token",
  abortChatTitleRefresh,
  acquireSingleInstanceLock,
  bot,
  cleanupOrphanedTempFiles,
  closeTranslate,
  drainAntiRaid,
  drainAvatarUpdates,
  drainReactionQueue,
  drainTranslate,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  getMoodConfig,
  getReactionConfig,
  getStickerConfig,
  hydrateAiMemory,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAvatarUpdates,
  initAiChat,
  initDiskIO,
  initTelegramClients,
  initAntiRaid,
  initChatTitleRefresh,
  initReactionQueue,
  initTranslate,
  loadPersistedData,
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
  loadState,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runAcknowledgedUpdateBatches,
  quiesceAvatarUpdates,
  quiesceChatTitleRefresh,
  quiesceReactionQueue,
  quiesceTranslate,
  seedSenderCache,
  setStatePersistenceFatalHandler,
  sleep,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
} as unknown as ApplicationLifecycleDependencies;

const { ApplicationLifecycle } = await import("../../src/app/lifecycle");

beforeEach(() => {
  calls.length = 0;
  diskIOFatalHandler = undefined;
  copiedUser = null;
  lastSeenUpdateId = 0;
  process.exitCode = 0;
  for (const mocked of [
    acquireSingleInstanceLock,
    releaseSingleInstanceLock,
    getStickerConfig,
    getReactionConfig,
    getMoodConfig,
    initTelegramClients,
    initDiskIO,
    cleanupOrphanedTempFiles,
    loadState,
    refreshAllChatTitles,
    loadPersistedData,
    flushDiskIO,
    flushStateToDisk,
    flushAiMemory,
    terminateDiskIO,
    terminateAiChat,
    terminateAntiRaid,
    drainAntiRaid,
    drainReactionQueue,
    drainAvatarUpdates,
    drainTranslate,
    closeTranslate,
    initAvatarUpdates,
    initReactionQueue,
    initChatTitleRefresh,
    initTranslate,
    quiesceAvatarUpdates,
    quiesceReactionQueue,
    quiesceChatTitleRefresh,
    quiesceTranslate,
    abortChatTitleRefresh,
    hydrateAiMemory,
    hydrateStickerCatalog,
    initAiChat,
    hydratePendingVerifications,
    initAntiRaid,
    restoreLuckState,
    seedSenderCache,
    setStatePersistenceFatalHandler,
    registerCommandMenu,
    registerHandlers,
    sleep,
    loggerError,
    getUpdates,
    botInit,
    runnerStop,
    runnerTask,
    runnerSize,
    runAcknowledgedUpdateBatches,
  ]) mocked.mockClear();
  acquireSingleInstanceLock.mockImplementation(async (): Promise<void> => { calls.push("acquireLock"); });
  getStickerConfig.mockImplementation((): object => ({}));
  refreshAllChatTitles.mockImplementation(async (): Promise<void> => { calls.push("refreshTitles"); });
  flushDiskIO.mockImplementation(async () => { calls.push("flushDiskIO"); return "flushed" as const; });
  flushStateToDisk.mockImplementation(async () => { calls.push("flushState"); return "flushed" as const; });
  flushAiMemory.mockImplementation(async () => { calls.push("flushAiMemory"); return "flushed" as const; });
  drainAntiRaid.mockImplementation(async () => { calls.push("drainAntiRaid"); return "flushed" as const; });
  drainReactionQueue.mockImplementation(async () => { calls.push("drainReaction"); return "flushed" as const; });
  drainAvatarUpdates.mockImplementation(async () => { calls.push("drainAvatar"); return "flushed" as const; });
  drainTranslate.mockImplementation(async () => { calls.push("drainTranslate"); return "flushed" as const; });
  closeTranslate.mockImplementation(async () => { calls.push("closeTranslate"); return "flushed" as const; });
  runnerTask.mockImplementation(async (): Promise<void> => {});
  runnerSize.mockImplementation((): number => 0);
});

afterEach(() => {
  // Bun 在 test isolate 内把 undefined 视为“保留现有退出码”；显式归零，
  // 避免本文件刻意覆盖的启动失败路径把整个测试命令误报为失败。
  process.exitCode = 0;
});

describe("应用启动失败与退出清理", () => {
  test("取得单实例锁后配置校验失败，run 仍刷 state、释放锁并移除进程监听器", async () => {
    getStickerConfig.mockImplementationOnce((): never => { throw new Error("invalid stickers.json"); });
    const beforeSigint: number = process.listenerCount("SIGINT");
    const beforeSigterm: number = process.listenerCount("SIGTERM");
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(acquireSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
    expect(loggerError).toHaveBeenCalledWith("Unhandled error in bot main runner:", expect.any(Error));
  });

  test("state 清理与 LKG 恢复完成后才初始化 Telegram 和 Disk I/O Worker", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    expect(calls.indexOf("cleanupTemps")).toBeLessThan(calls.indexOf("loadState"));
    expect(calls.indexOf("loadState")).toBeLessThan(calls.indexOf("initTelegram"));
    expect(calls.indexOf("loadState")).toBeLessThan(calls.indexOf("initDiskIO"));
    expect(calls.indexOf("botInit")).toBeLessThan(calls.indexOf("runUpdates"));
    expect(calls.indexOf("runUpdates")).toBeLessThan(calls.indexOf("refreshTitles"));
    await lifecycle.dispose();
  });

  test("state 主备均不可恢复时不启动任何运行时 Worker，并释放实例锁", async () => {
    loadState.mockRejectedValueOnce(new Error("manual recovery is required"));
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("轮询任务异常后执行完整持久化顺序并只释放一次锁", async () => {
    runnerTask.mockRejectedValueOnce(new Error("polling failed"));
    copiedUser = { id: 7 };
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(seedSenderCache).toHaveBeenCalledTimes(1);
    expect(initAiChat).toHaveBeenCalledTimes(1);
    expect(hydrateAiMemory).toHaveBeenCalledTimes(1);
    expect(hydrateStickerCatalog).toHaveBeenCalledTimes(1);
    expect(hydratePendingVerifications).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("flushAiMemory")).toBeLessThan(calls.indexOf("flushDiskIO"));
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(terminateAiChat).toHaveBeenCalledTimes(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(runnerStop).not.toHaveBeenCalled();
  });

  test("主动 dispose 会先停止仍在运行的 runner，再排空 AI、磁盘和状态", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(initTranslate).toHaveBeenCalledTimes(1);
    expect(quiesceTranslate).toHaveBeenCalledTimes(1);
    expect(drainTranslate).toHaveBeenCalledTimes(1);
    expect(closeTranslate).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("runnerStop")).toBeLessThan(calls.indexOf("flushAiMemory"));
    expect(calls.indexOf("quiesceTranslate")).toBeLessThan(calls.indexOf("drainTranslate"));
    expect(calls.indexOf("drainTranslate")).toBeLessThan(calls.indexOf("closeTranslate"));
    expect(calls.indexOf("flushAiMemory")).toBeLessThan(calls.indexOf("terminateAiChat"));
    expect(calls.indexOf("flushDiskIO")).toBeLessThan(calls.indexOf("terminateDiskIO"));
  });

  test("dispose 在 Anti-Raid drain 落定前不得 flush 或终止任何业务 Worker", async () => {
    const antiRaidGate = deferred<FlushResult>();
    drainAntiRaid.mockImplementationOnce(() => {
      calls.push("drainAntiRaid");
      return antiRaidGate.promise;
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const disposing = lifecycle.dispose();
    await Bun.sleep(0);

    expect(drainAntiRaid).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).not.toHaveBeenCalled();
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(terminateAiChat).not.toHaveBeenCalled();
    expect(terminateAntiRaid).not.toHaveBeenCalled();
    expect(terminateDiskIO).not.toHaveBeenCalled();

    antiRaidGate.resolve("flushed");
    await disposing;

    expect(calls.indexOf("drainAntiRaid")).toBeLessThan(calls.indexOf("flushAiMemory"));
    expect(calls.indexOf("flushAiMemory")).toBeLessThan(calls.indexOf("terminateAiChat"));
    expect(calls.indexOf("terminateAiChat")).toBeLessThan(calls.indexOf("flushDiskIO"));
    expect(calls.indexOf("flushDiskIO")).toBeLessThan(calls.indexOf("terminateAntiRaid"));
    expect(calls.indexOf("terminateAntiRaid")).toBeLessThan(calls.indexOf("terminateDiskIO"));
    expect(calls.indexOf("terminateDiskIO")).toBeLessThan(calls.indexOf("flushState"));
  });

  test("Anti-Raid drain 失败仍终止 Worker，但设置非零退出码并保留实例锁", async () => {
    drainAntiRaid.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("antiRaid=failed"));
  });

  test("翻译 drain 超时仍关闭 gRPC 客户端，并保留实例锁", async () => {
    drainTranslate.mockResolvedValueOnce("timedOut");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(closeTranslate).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("translate=timedOut"));
  });

  test("Disk I/O 运行时 fatal 会设置非零退出码并停止继续取 update", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    diskIOFatalHandler!(new Error("runtime recovery failed"));
    await lifecycle.wait();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Persistence became unavailable at runtime; stopping for a supervised restart:",
      expect.any(Error)
    );
  });

  test("标题维护永不结束时 dispose 仍在预算内终止 Worker，并保留实例锁", async () => {
    refreshAllChatTitles.mockImplementationOnce(() => new Promise<void>(() => {}));
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose({ aiMemoryMs: 10, diskIOMs: 10, stateMs: 10, maintenanceMs: 1 });

    expect(terminateAiChat).toHaveBeenCalledTimes(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(abortChatTitleRefresh).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Retaining the single-instance lock"));
  });

  test("state writer 超时且可能仍会 rename 时不释放实例锁", async () => {
    flushStateToDisk.mockResolvedValueOnce("timedOut");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose({ aiMemoryMs: 10, diskIOMs: 10, stateMs: 1, maintenanceMs: 10 });

    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("state=timedOut"));
  });

  test("state writer 明确失败时也保留实例锁，不能假设后台重试已经停止", async () => {
    flushStateToDisk.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose({ aiMemoryMs: 10, diskIOMs: 10, stateMs: 1, maintenanceMs: 10 });

    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("state=failed"));
  });

  test("Disk flush 明确失败时设置非零退出码并保留实例锁", async () => {
    flushDiskIO.mockResolvedValue("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose({ aiMemoryMs: 10, diskIOMs: 10, stateMs: 10, maintenanceMs: 10 });

    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("disk=failed"));
  });

  test("正常 wait 会等待 runner 排空并确认最后 update offset", async () => {
    runnerSize.mockReturnValueOnce(1).mockReturnValue(0);
    lastSeenUpdateId = 321;
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenCalledWith({ offset: 322, limit: 1, timeout: 0 });
    expect(flushAiMemory).toHaveBeenCalledTimes(2);
    expect(flushDiskIO).toHaveBeenCalledTimes(2);
    expect(flushStateToDisk).toHaveBeenCalledTimes(2);
    expect(drainTranslate).toHaveBeenCalledTimes(2);
    expect(closeTranslate).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("wait 在 Anti-Raid drain 完成前不得 flush，更不得确认 offset", async () => {
    const antiRaidGate = deferred<FlushResult>();
    drainAntiRaid.mockImplementationOnce(() => {
      calls.push("drainAntiRaid");
      return antiRaidGate.promise;
    });
    lastSeenUpdateId = 654;
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const waiting = lifecycle.wait();
    await Bun.sleep(0);

    expect(drainAntiRaid).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).not.toHaveBeenCalled();
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();
    expect(getUpdates).not.toHaveBeenCalled();

    antiRaidGate.resolve("flushed");
    await waiting;

    expect(calls.indexOf("drainAntiRaid")).toBeLessThan(calls.indexOf("flushAiMemory"));
    expect(calls.indexOf("flushAiMemory")).toBeLessThan(calls.indexOf("flushDiskIO"));
    expect(calls.indexOf("flushDiskIO")).toBeLessThan(calls.indexOf("flushState"));
    expect(calls.indexOf("flushState")).toBeLessThan(calls.indexOf("getUpdates"));
    expect(getUpdates).toHaveBeenCalledWith({ offset: 655, limit: 1, timeout: 0 });
    await lifecycle.dispose();
  });

  test("确认前 Anti-Raid drain 超时会阻止 offset，并把失败传播到退出状态", async () => {
    lastSeenUpdateId = 777;
    drainAntiRaid.mockResolvedValueOnce("timedOut");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();

    expect(process.exitCode).toBe(1);
    expect(getUpdates).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("antiRaid=timedOut"));
    await lifecycle.dispose();
  });

  test("确认前任一持久化边界失败时不确认 update offset", async () => {
    lastSeenUpdateId = 321;
    flushDiskIO.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("final Telegram update offset will not be confirmed"));
  });

  test("排空超时且仍有 update 在处理时不确认 offset", async () => {
    let now: number = 1_000;
    const originalDateNow = Date.now;
    Date.now = (): number => now;
    runnerSize.mockReturnValue(2);
    sleep.mockImplementation(async (): Promise<void> => { now += 5_000; });
    lastSeenUpdateId = 321;
    const lifecycle = new ApplicationLifecycle(testDependencies);

    try {
      await lifecycle.init();
      await lifecycle.wait();
      await lifecycle.dispose();
    } finally {
      Date.now = originalDateNow;
    }

    expect(getUpdates).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("offset will not be confirmed"));
  });

  test("并发 update 乱序完成时不会跨过仍在途的较小 update", async () => {
    let now: number = 2_000;
    const originalDateNow = Date.now;
    Date.now = (): number => now;
    // 较大的 update 已经完成，但较小的 update 仍占据 runner，因此 size 始终非零。
    runnerSize.mockReturnValue(1);
    sleep.mockImplementation(async (): Promise<void> => { now += 5_000; });
    lastSeenUpdateId = 900;
    const lifecycle = new ApplicationLifecycle(testDependencies);

    try {
      await lifecycle.init();
      await lifecycle.wait();
      await lifecycle.dispose();
    } finally {
      Date.now = originalDateNow;
    }

    expect(getUpdates).not.toHaveBeenCalled();
  });
});
