import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  EMERGENCY_FLUSH_TIMEOUTS,
  EMERGENCY_REUSED_DISPOSE_DEADLINE_MS,
  FINAL_OFFSET_CONFIRM_TIMEOUT_MS,
} from "../../packages/consts/lifecycle";
import type { ApplicationLifecycleDependencies } from "../../packages/types/lifecycle";
import type { BlocklistConfig } from "../../packages/types/blocklist";

const calls: string[] = [];
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const acquireSingleInstanceLock = mock(async (): Promise<void> => { calls.push("acquireLock"); });
const releaseSingleInstanceLock = mock(async (): Promise<void> => { calls.push("releaseLock"); });
const initTelegramClients = mock((): void => { calls.push("initTelegram"); });
let diskIOFatalHandler: ((error: Error) => void) | undefined;
let businessWorkerFatalHandler: ((error: Error) => void) | undefined;
const initDiskIO = mock((options?: { onFatal?: (error: Error) => void }): void => {
  calls.push("initDiskIO");
  diskIOFatalHandler = options?.onFatal;
});
const cleanupOrphanedTempFiles = mock(async (): Promise<void> => { calls.push("cleanupTemps"); });
const preflightEnabledFeatures = mock((): void => { calls.push("preflightFeatures"); });
const loadState = mock(async (): Promise<void> => { calls.push("loadState"); });
const refreshAllChatTitles = mock(async (): Promise<void> => { calls.push("refreshTitles"); });
const loadPersistedData = mock(async () => ({
  aiMemories: new Map<number, string>(),
  stickerCatalogs: new Map<string, string>(),
  luckDay: null,
  luckReceiptSecret: { day: "2026-07-19", secret: "test-secret" },
  verifications: new Map<string, never>(),
  blockedUsers: new Map<number, true>(),
  pendingBlockedRemovals: new Map(),
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
const hydrateBlocklist = mock((..._args: unknown[]): void => { calls.push("hydrateBlocklist"); });
const initAntiRaid = mock((): void => { calls.push("initAntiRaid"); });
const sweepManagedBlocklistChats = mock(async (): Promise<void> => { calls.push("sweepBlocklist"); });
const restoreLuckState = mock((..._args: unknown[]): void => { calls.push("restoreLuck"); });
const seedSenderCache = mock((_value: unknown): void => { calls.push("seedSender"); });
const registerCommandMenu = mock(async (): Promise<void> => { calls.push("registerMenu"); });
let lastSeenUpdateId: number = 0;
const registerHandlers = mock(() => ({ getLastSeenUpdateId: (): number => lastSeenUpdateId }));
const getAllChatStates = mock(() => new Map<number, unknown>());
let copiedUser: object | null = null;
const getGlobalCopyState = mock(() => ({ copiedUser }));
const getWhitelistConfig = mock(() => {
  calls.push("loadWhitelist");
  return new Map();
});
const loadBlocklistConfig = mock((): BlocklistConfig => {
  calls.push("loadBlocklist");
  return { blockedIds: [7, -4004] };
});
const sleep = mock(async (): Promise<void> => {});
const setStatePersistenceFatalHandler = mock((_handler: ((error: Error) => void) | undefined): void => {});
const setBusinessWorkerFatalHandler = mock((handler: ((error: Error) => void) | undefined): void => {
  businessWorkerFatalHandler = handler;
});
const loggerError = mock((..._args: unknown[]): void => {});
const getUpdates = mock(async (
  _params?: { offset: number; limit: number; timeout: number },
  _signal?: AbortSignal
): Promise<unknown[]> => { calls.push("getUpdates"); return []; });
const botInit = mock(async (): Promise<void> => { calls.push("botInit"); });
const bot = {
  botInfo: { id: 99, first_name: "Ninja", username: "ninja_bot", is_bot: true },
  init: botInit,
  api: { getUpdates },
};

const runnerStop = mock(async (): Promise<void> => { calls.push("runnerStop"); });
const runnerTask = mock(async (): Promise<void> => {});
const runnerSize = mock((): number => 0);
const runnerAbortActive = mock((): number => 0);
const runnerHasFailedUpdate = mock((): boolean => false);
const runnerHandle = {
  stop: runnerStop,
  task: runnerTask,
  size: runnerSize,
  abortActive: runnerAbortActive,
  hasFailedUpdate: runnerHasFailedUpdate,
};
const runAcknowledgedUpdateBatches = mock((_bot: unknown, _updates: unknown) => {
  calls.push("runUpdates");
  return runnerHandle;
});

const testDependencies = {
  BOT_TOKEN: "test-token",
  SUPER_ADMIN_USER_ID: 1,
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
  getWhitelistConfig,
  hydrateAiMemory,
  hydratePendingVerifications,
  hydrateBlocklist,
  hydrateStickerCatalog,
  initAvatarUpdates,
  initAiChat,
  initDiskIO,
  initTelegramClients,
  initAntiRaid,
  initChatTitleRefresh,
  initReactionQueue,
  initTranslate,
  loadBlocklistConfig,
  loadPersistedData,
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
  loadState,
  preflightEnabledFeatures,
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
  setBusinessWorkerFatalHandler,
  setStatePersistenceFatalHandler,
  sleep,
  sweepManagedBlocklistChats,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
} as unknown as ApplicationLifecycleDependencies;

const { ApplicationLifecycle } = await import("../../packages/app/lifecycle");
// 异常退出路径必须用真实 drain：忽略 timeoutMs 的替身会把参数校验整个跳过，
// 紧急预算（maintenanceMs = 0）下的真实行为就永远测不到。
const { drainAvatarUpdates: realDrainAvatarUpdates } = await import("../../packages/copy/avatarQueue");
const { drainReactionQueue: realDrainReactionQueue } = await import("../../packages/copy/reactionQueue");
const realDrainDependencies = {
  ...testDependencies,
  drainAvatarUpdates: realDrainAvatarUpdates,
  drainReactionQueue: realDrainReactionQueue,
} as unknown as ApplicationLifecycleDependencies;

beforeEach(() => {
  calls.length = 0;
  diskIOFatalHandler = undefined;
  businessWorkerFatalHandler = undefined;
  copiedUser = null;
  lastSeenUpdateId = 0;
  process.exitCode = 0;
  for (const mocked of [
    acquireSingleInstanceLock,
    releaseSingleInstanceLock,
    initTelegramClients,
    initDiskIO,
    cleanupOrphanedTempFiles,
    preflightEnabledFeatures,
    getWhitelistConfig,
    loadBlocklistConfig,
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
    hydrateBlocklist,
    initAntiRaid,
    sweepManagedBlocklistChats,
    restoreLuckState,
    seedSenderCache,
    setBusinessWorkerFatalHandler,
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
    runnerAbortActive,
    runnerHasFailedUpdate,
    runAcknowledgedUpdateBatches,
  ]) mocked.mockClear();
  acquireSingleInstanceLock.mockImplementation(async (): Promise<void> => { calls.push("acquireLock"); });
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
  runnerHasFailedUpdate.mockImplementation((): boolean => false);
  getUpdates.mockImplementation(async (): Promise<unknown[]> => {
    calls.push("getUpdates");
    return [];
  });
});

afterEach(() => {
  // Bun 在 test isolate 内把 undefined 视为“保留现有退出码”；显式归零，
  // 避免本文件刻意覆盖的启动失败路径把整个测试命令误报为失败。
  process.exitCode = 0;
});

describe("应用启动失败与退出清理", () => {
  // 部署配置不再在这里预热（见 config/readiness.ts），因此这条「持锁之后 init
  // 抛错」的路径改由临时文件清理注入失败——它是持锁与 initDiskIO 之间仍然存在的
  // 那一步，断言的收尾语义与原来完全一致。
  test("取得单实例锁后 init 抛错，run 仍刷 state、释放锁并移除进程监听器", async () => {
    cleanupOrphanedTempFiles.mockImplementationOnce(async (): Promise<never> => {
      throw new Error("temp cleanup failed");
    });
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

  test("白名单配置损坏时在联网和 Worker 启动前拒绝启动", async () => {
    getWhitelistConfig.mockImplementationOnce((): never => {
      throw new Error("Invalid whitelist config");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("静态黑名单配置损坏时同样在联网和 Worker 启动前拒绝启动", async () => {
    loadBlocklistConfig.mockImplementationOnce((): never => {
      throw new Error("Invalid blocklist config");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("静态黑名单与白名单身份冲突时在联网和 Worker 启动前拒绝启动", async () => {
    getWhitelistConfig.mockImplementationOnce(() => new Map([[7, {} as never]]));
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Unhandled error in bot main runner:",
      expect.objectContaining({ message: expect.stringContaining("protected identity 7") })
    );
  });

  test("持久化动态黑名单包含超级管理员时拒绝启动 Telegram handler", async () => {
    loadPersistedData.mockResolvedValueOnce({
      aiMemories: new Map<number, string>(),
      stickerCatalogs: new Map<string, string>(),
      luckDay: null,
      luckReceiptSecret: { day: "2026-07-19", secret: "test-secret" },
      verifications: new Map<string, never>(),
      blockedUsers: new Map<number, true>([[1, true]]),
      pendingBlockedRemovals: new Map(),
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(initDiskIO).toHaveBeenCalledTimes(1);
    expect(registerHandlers).not.toHaveBeenCalled();
    expect(botInit).not.toHaveBeenCalled();
    expect(hydrateBlocklist).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("state 清理与 LKG 恢复完成后才初始化 Telegram 和 Disk I/O Worker", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    expect(calls.indexOf("cleanupTemps")).toBeLessThan(calls.indexOf("loadState"));
    expect(calls.indexOf("acquireLock")).toBeLessThan(calls.indexOf("loadWhitelist"));
    expect(calls.indexOf("loadWhitelist")).toBeLessThan(calls.indexOf("initTelegram"));
    expect(calls.indexOf("loadBlocklist")).toBeLessThan(calls.indexOf("initTelegram"));
    expect(calls.indexOf("loadState")).toBeLessThan(calls.indexOf("initTelegram"));
    expect(calls.indexOf("loadState")).toBeLessThan(calls.indexOf("initDiskIO"));
    expect(hydrateBlocklist).toHaveBeenCalledWith(
      expect.any(Map),
      expect.any(Map),
      [7, -4004]
    );
    expect(calls.indexOf("initAntiRaid")).toBeLessThan(
      calls.indexOf("sweepBlocklist")
    );
    expect(calls.indexOf("sweepBlocklist")).toBeLessThan(
      calls.indexOf("runUpdates")
    );
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

  test("实例锁释放失败进入停机结果，重复 dispose 不会误报成功或重复释放", async () => {
    releaseSingleInstanceLock.mockImplementationOnce(async (): Promise<void> => {
      calls.push("releaseLock");
      throw new Error("lock unlink failed");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Shutdown owner single-instance lock release threw during disposal:",
      expect.any(Error)
    );
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

  test("普通 dispose 在途时发生致命异常会受独立硬截止约束且只请求退出一次", async () => {
    const antiRaidGate = deferred<FlushResult>();
    drainAntiRaid.mockImplementationOnce(() => {
      calls.push("drainAntiRaid");
      return antiRaidGate.promise;
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const disposing = lifecycle.dispose();
    await Bun.sleep(0);

    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    const originalClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
    const deadlineToken = {} as ReturnType<typeof setTimeout>;
    let deadlineCallback: (() => void) | null = null;
    let deadlineDelayMs: number | undefined;
    let deadlineCleared: boolean = false;
    const exit = spyOn(process, "exit").mockImplementation(
      (_code?: string | number | null): never => undefined as never
    );
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
      deadlineCallback = callback;
      deadlineDelayMs = delay;
      return deadlineToken;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>): void => {
      if (timer === deadlineToken) deadlineCleared = true;
    }) as typeof clearTimeout;

    try {
      // 直接触发私有入口，避免向测试进程广播 uncaughtException 干扰 Bun runner。
      (lifecycle as unknown as { exitAfterEmergencyDispose(): void }).exitAfterEmergencyDispose();

      expect(deadlineDelayMs).toBe(EMERGENCY_REUSED_DISPOSE_DEADLINE_MS);
      expect(drainAntiRaid).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      deadlineCallback!();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("hard deadline"));

      antiRaidGate.resolve("flushed");
      await disposing;
      await Promise.resolve();

      expect(deadlineCleared).toBe(true);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      antiRaidGate.resolve("flushed");
      await disposing;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      exit.mockRestore();
    }
  });

  test("紧急预算下真实 drain 不再抛错，AI/磁盘/state 与 fatal handler 全部收尾", async () => {
    const lifecycle = new ApplicationLifecycle(realDrainDependencies);
    await lifecycle.init();

    await expect(lifecycle.dispose(EMERGENCY_FLUSH_TIMEOUTS)).resolves.toBeUndefined();

    expect(flushAiMemory).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(terminateAiChat).toHaveBeenCalledTimes(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(setBusinessWorkerFatalHandler).toHaveBeenLastCalledWith(undefined);
    expect(setStatePersistenceFatalHandler).toHaveBeenLastCalledWith(undefined);
  });

  test("任一 owner 抛错时其余 owner 仍执行，退出码置 1 并保留实例锁", async () => {
    drainAvatarUpdates.mockImplementationOnce((): never => { throw new Error("avatar drain exploded"); });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await expect(lifecycle.dispose()).resolves.toBeUndefined();

    expect(drainReactionQueue).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(terminateAiChat).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(setBusinessWorkerFatalHandler).toHaveBeenLastCalledWith(undefined);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("avatar=failed"));
  });

  test("任一 quiesce 抛错时仍关闭其余入口，并把失败纳入停机结果", async () => {
    quiesceAvatarUpdates.mockImplementationOnce((): never => {
      calls.push("quiesceAvatar");
      throw new Error("avatar quiesce exploded");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await expect(lifecycle.dispose()).resolves.toBeUndefined();

    expect(quiesceReactionQueue).toHaveBeenCalledTimes(1);
    expect(quiesceChatTitleRefresh).toHaveBeenCalledTimes(1);
    expect(quiesceTranslate).toHaveBeenCalledTimes(1);
    expect(drainAvatarUpdates).toHaveBeenCalledTimes(1);
    expect(drainReactionQueue).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "Shutdown owner avatar quiesce threw during shutdown:",
      expect.any(Error)
    );
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("maintenance=false"));
  });

  test("紧急预算跳过未结束的标题刷新时必须 abort 标题 owner", async () => {
    refreshAllChatTitles.mockImplementationOnce(() => new Promise<void>(() => {}));
    const lifecycle = new ApplicationLifecycle(realDrainDependencies);
    await lifecycle.init();

    await lifecycle.dispose(EMERGENCY_FLUSH_TIMEOUTS);

    expect(abortChatTitleRefresh).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
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

  test("业务 Worker 永久不可用时会设置非零退出码并停止继续取 update", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    businessWorkerFatalHandler!(new Error("AI Worker replay failed"));
    await lifecycle.wait();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Business Worker became unavailable at runtime; stopping for a supervised restart:",
      expect.any(Error)
    );
  });

  test("标题维护永不结束时 dispose 设置非零退出码、终止 Worker 并保留实例锁", async () => {
    refreshAllChatTitles.mockImplementationOnce(() => new Promise<void>(() => {}));
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose({ aiMemoryMs: 10, diskIOMs: 10, stateMs: 10, maintenanceMs: 1 });

    expect(process.exitCode).toBe(1);
    expect(terminateAiChat).toHaveBeenCalledTimes(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(abortChatTitleRefresh).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("maintenance=false"));
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
    expect(getUpdates).toHaveBeenCalledWith(
      { offset: 322, limit: 1, timeout: 0 },
      expect.any(AbortSignal)
    );
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
    expect(getUpdates).toHaveBeenCalledWith(
      { offset: 655, limit: 1, timeout: 0 },
      expect.any(AbortSignal)
    );
    await lifecycle.dispose();
  });

  test("最终 offset 确认失败会非零退出并阻止干净释放实例锁", async () => {
    lastSeenUpdateId = 432;
    getUpdates.mockRejectedValueOnce(new Error("confirmation failed"));
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "Failed to confirm update offset on shutdown:",
      expect.any(Error)
    );
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("offset=false"));
  });

  test("永不自行 settle 的最终确认受专用 AbortSignal 截断", async () => {
    lastSeenUpdateId = 543;
    const originalTimeout: typeof AbortSignal.timeout = AbortSignal.timeout;
    let requestedTimeoutMs: number | undefined;
    AbortSignal.timeout = ((timeoutMs: number): AbortSignal => {
      requestedTimeoutMs = timeoutMs;
      return AbortSignal.abort(new DOMException("confirmation timed out", "TimeoutError"));
    }) as typeof AbortSignal.timeout;
    getUpdates.mockImplementationOnce(async (
      _params?: { offset: number; limit: number; timeout: number },
      signal?: AbortSignal
    ): Promise<unknown[]> => {
      calls.push("getUpdates");
      if (signal?.aborted === true) throw signal.reason;
      return new Promise<unknown[]>(() => {});
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    try {
      await lifecycle.init();
      await lifecycle.wait();
      await lifecycle.dispose();
    } finally {
      AbortSignal.timeout = originalTimeout;
    }

    expect(requestedTimeoutMs).toBe(FINAL_OFFSET_CONFIRM_TIMEOUT_MS);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
  });

  test("wait 首次维护超时后即使 dispose 时落定也不能改写未确认结果", async () => {
    const maintenance = deferred<void>();
    refreshAllChatTitles.mockImplementationOnce((): Promise<void> => maintenance.promise);
    lastSeenUpdateId = 654;
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    const originalClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
    const timeoutToken = {} as ReturnType<typeof setTimeout>;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void): ReturnType<typeof setTimeout> => {
      queueMicrotask(callback);
      return timeoutToken;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_timer: ReturnType<typeof setTimeout>): void => {}) as typeof clearTimeout;
    try {
      await lifecycle.wait();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    maintenance.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("offset=false"));
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

  test("停机时有 update 处理失败：不确认 offset 并以非零状态退出", async () => {
    // 停机路径放弃在途批次后 task() 会正常 resolve，排空也会归零，光靠这两者
    // 无法发现那批里失败的 update。漏掉就等于替 Telegram 确认了一条从未成功
    // 处理的 update，重启后不会再收到它。
    lastSeenUpdateId = 888;
    runnerHasFailedUpdate.mockReturnValue(true);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Withholding the final Telegram offset")
    );
    await lifecycle.dispose();
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
    expect(runnerAbortActive).toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("withholding their Telegram offset"));
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
