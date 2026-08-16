import { afterEach, beforeEach, mock } from "bun:test";
import { ApplicationLifecycle } from "../../packages/app/lifecycle";
import { drainAvatarUpdates as realDrainAvatarUpdates } from "../../packages/copy/avatarQueue";
import { drainReactionQueue as realDrainReactionQueue } from "../../packages/copy/reactionQueue";
import type { ApplicationLifecycleDependencies } from "../../packages/app/lifecycleDependencies";

const calls: string[] = [];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => { resolve = done; });
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
const validateExistingDeploymentInputs = mock((): void => {
  calls.push("validateDeploymentInputs");
});
const seedMissingAssetState = mock((): number => { calls.push("seedAssets"); return 0; });
const loadState = mock(async (): Promise<void> => { calls.push("loadState"); });
const refreshAllChatTitles = mock(async (): Promise<void> => { calls.push("refreshTitles"); });
const loadPersistedData = mock(async () => ({
  aiMemories: new Map<number, string>(),
  stickerCatalogs: new Map<string, string>(),
  luckDay: null,
  luckReceiptSecret: { day: "2026-07-19", secret: "test-secret" },
  verifications: new Map<string, never>(),
  pendingBlockedRemovals: new Map(),
  blocklistEntryCount: 0,
  chatStates: new Map<number, never>(),
  whitelistEntryCount: 0,
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
const drainGagRuntime = mock(async (): Promise<FlushResult> => { calls.push("drainGag"); return "flushed"; });
const drainTranslate = mock(async (): Promise<FlushResult> => { calls.push("drainTranslate"); return "flushed"; });
const drainPendingMessageDeletions = mock(async (): Promise<FlushResult> => {
  calls.push("drainMessageDeletions");
  return "flushed";
});
const drainTelegramOutbound = mock(async (): Promise<FlushResult> => {
  calls.push("drainTelegramOutbound");
  return "flushed";
});
const closeTranslate = mock(async (): Promise<FlushResult> => { calls.push("closeTranslate"); return "flushed"; });
const initAvatarUpdates = mock((): void => { calls.push("initAvatar"); });
const initGagRuntime = mock((): void => { calls.push("initGag"); });
const initReactionQueue = mock((): void => { calls.push("initReaction"); });
const initChatTitleRefresh = mock((): void => { calls.push("initTitles"); });
const initTranslate = mock((): void => { calls.push("initTranslate"); });
const quiesceAvatarUpdates = mock((): void => { calls.push("quiesceAvatar"); });
const quiesceReactionQueue = mock((): void => { calls.push("quiesceReaction"); });
const quiesceChatTitleRefresh = mock((): void => { calls.push("quiesceTitles"); });
const quiesceTranslate = mock((): void => { calls.push("quiesceTranslate"); });
const quiesceGagRuntime = mock((): void => { calls.push("quiesceGag"); });
const abortChatTitleRefresh = mock((): void => { calls.push("abortTitles"); });
const hydrateAiMemory = mock((_value: unknown): void => { calls.push("hydrateAiMemory"); });
const hydrateStickerCatalog = mock((_value: unknown): void => { calls.push("hydrateStickerCatalog"); });
const initAiChat = mock((_value: unknown): void => { calls.push("initAiChat"); });
const hydratePendingVerifications = mock((_value: unknown): void => { calls.push("hydrateVerifications"); });
const hydrateChatStateCache = mock((_value: unknown): void => { calls.push("hydrateChatStates"); });
const hydrateIdentityStorageCounts = mock((..._args: unknown[]): void => { calls.push("hydrateIdentityCounts"); });
const assertSuperAdminNotBlocked = mock(async (..._args: unknown[]): Promise<void> => { calls.push("assertSuperAdminNotBlocked"); });
const hydrateBlocklist = mock((..._args: unknown[]): void => { calls.push("hydrateBlocklist"); });
const initAntiRaid = mock((): void => { calls.push("initAntiRaid"); });
const initBlocklistSweepScheduler = mock((): void => { calls.push("initBlocklistScheduler"); });
const quiesceBlocklistSweepScheduler = mock((): void => { calls.push("quiesceBlocklistScheduler"); });
const sweepManagedBlocklistChats = mock(async (): Promise<void> => { calls.push("sweepBlocklist"); });
const restoreLuckState = mock((..._args: unknown[]): void => { calls.push("restoreLuck"); });
const seedSenderCache = mock((_value: unknown): void => { calls.push("seedSender"); });
const registerCommandMenu = mock(async (): Promise<void> => { calls.push("registerMenu"); });
let lastSeenUpdateId: number = 0;
const registerHandlers = mock(() => ({ getLastSeenUpdateId: (): number => lastSeenUpdateId }));
const getChatStateCache = mock(() => new Map<number, unknown>());
let copiedUser: object | null = null;
const getGlobalCopyState = mock(() => ({ copiedUser }));
const sleep = mock(async (): Promise<void> => {});
let monotonicTime: number = 0;
const monotonicNow = mock((): number => monotonicTime);
const setStatePersistenceFatalHandler = mock((_handler: ((error: Error) => void) | undefined): void => {});
const setBusinessWorkerFatalHandler = mock((handler: ((error: Error) => void) | undefined): void => {
  businessWorkerFatalHandler = handler;
});
const loggerLog = mock((..._args: unknown[]): void => {});
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
  drainGagRuntime,
  drainReactionQueue,
  drainTranslate,
  drainPendingMessageDeletions,
  drainTelegramOutbound,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getChatStateCache,
  getGlobalCopyState,
  assertSuperAdminNotBlocked,
  hydrateIdentityStorageCounts,
  hydrateChatStateCache,
  hydrateAiMemory,
  hydratePendingVerifications,
  hydrateBlocklist,
  hydrateStickerCatalog,
  initAvatarUpdates,
  initGagRuntime,
  initAiChat,
  initDiskIO,
  initTelegramClients,
  initAntiRaid,
  initBlocklistSweepScheduler,
  initChatTitleRefresh,
  initReactionQueue,
  initTranslate,
  loadPersistedData,
  logger: {
    log: loggerLog,
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
  monotonicNow,
  loadState,
  validateExistingDeploymentInputs,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runAcknowledgedUpdateBatches,
  seedMissingAssetState,
  quiesceAvatarUpdates,
  quiesceBlocklistSweepScheduler,
  quiesceChatTitleRefresh,
  quiesceReactionQueue,
  quiesceGagRuntime,
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

// 异常退出路径必须用真实 drain：忽略 timeoutMs 的替身会把参数校验整个跳过，
// 紧急预算（maintenanceMs = 0）下的真实行为就永远测不到。
const realDrainDependencies = {
  ...testDependencies,
  drainAvatarUpdates: realDrainAvatarUpdates,
  drainReactionQueue: realDrainReactionQueue,
} as unknown as ApplicationLifecycleDependencies;

function setCopiedUser(value: object | null): void {
  copiedUser = value;
}

function setLastSeenUpdateId(value: number): void {
  lastSeenUpdateId = value;
}

function advanceMonotonicTime(deltaMs: number): void {
  monotonicTime += deltaMs;
}

function triggerDiskIOFatal(error: Error): void {
  if (diskIOFatalHandler === undefined) throw new Error("Disk I/O fatal handler was not installed.");
  diskIOFatalHandler(error);
}

function triggerBusinessWorkerFatal(error: Error): void {
  if (businessWorkerFatalHandler === undefined) throw new Error("Business Worker fatal handler was not installed.");
  businessWorkerFatalHandler(error);
}

/** 为每个生命周期测试文件注册相同的隔离与 mock 复位边界。 */
export function installLifecycleFixtureHooks(): void {
  beforeEach(() => {
    calls.length = 0;
    diskIOFatalHandler = undefined;
    businessWorkerFatalHandler = undefined;
    copiedUser = null;
    lastSeenUpdateId = 0;
    process.exitCode = 0;
    monotonicTime = 0;
    for (const mocked of [
      acquireSingleInstanceLock,
      releaseSingleInstanceLock,
      initTelegramClients,
      initDiskIO,
      cleanupOrphanedTempFiles,
      validateExistingDeploymentInputs,
      loadState,
      seedMissingAssetState,
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
      drainGagRuntime,
      drainTranslate,
      drainPendingMessageDeletions,
      drainTelegramOutbound,
      closeTranslate,
      initAvatarUpdates,
      initGagRuntime,
      initReactionQueue,
      initChatTitleRefresh,
      initTranslate,
      quiesceAvatarUpdates,
      quiesceBlocklistSweepScheduler,
      quiesceReactionQueue,
      quiesceChatTitleRefresh,
      quiesceTranslate,
      quiesceGagRuntime,
      abortChatTitleRefresh,
      hydrateAiMemory,
      hydrateStickerCatalog,
      initAiChat,
      hydratePendingVerifications,
      assertSuperAdminNotBlocked,
      hydrateChatStateCache,
      hydrateIdentityStorageCounts,
      hydrateBlocklist,
      initAntiRaid,
      initBlocklistSweepScheduler,
      sweepManagedBlocklistChats,
      restoreLuckState,
      seedSenderCache,
      setBusinessWorkerFatalHandler,
      setStatePersistenceFatalHandler,
      registerCommandMenu,
      registerHandlers,
      sleep,
      monotonicNow,
      loggerLog,
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
    drainGagRuntime.mockImplementation(async () => { calls.push("drainGag"); return "flushed" as const; });
    drainTranslate.mockImplementation(async () => { calls.push("drainTranslate"); return "flushed" as const; });
    drainPendingMessageDeletions.mockImplementation(async () => {
      calls.push("drainMessageDeletions");
      return "flushed" as const;
    });
    drainTelegramOutbound.mockImplementation(async () => {
      calls.push("drainTelegramOutbound");
      return "flushed" as const;
    });
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
    // 避免刻意覆盖的启动失败路径把整个测试命令误报为失败。
    process.exitCode = 0;
  });
}

export const lifecycleFixture = {
  ApplicationLifecycle,
  abortChatTitleRefresh,
  acquireSingleInstanceLock,
  advanceMonotonicTime,
  botInit,
  calls,
  cleanupOrphanedTempFiles,
  closeTranslate,
  deferred,
  drainAntiRaid,
  drainAvatarUpdates,
  drainGagRuntime,
  drainPendingMessageDeletions,
  drainTelegramOutbound,
  drainReactionQueue,
  drainTranslate,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getUpdates,
  hydrateAiMemory,
  hydrateChatStateCache,
  hydrateBlocklist,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAiChat,
  initAntiRaid,
  initBlocklistSweepScheduler,
  initAvatarUpdates,
  initGagRuntime,
  initChatTitleRefresh,
  initDiskIO,
  initReactionQueue,
  initTelegramClients,
  initTranslate,
  loadPersistedData,
  loadState,
  loggerLog,
  loggerError,
  validateExistingDeploymentInputs,
  quiesceAvatarUpdates,
  quiesceBlocklistSweepScheduler,
  quiesceChatTitleRefresh,
  quiesceReactionQueue,
  quiesceGagRuntime,
  quiesceTranslate,
  realDrainDependencies,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runnerAbortActive,
  runnerHasFailedUpdate,
  runnerSize,
  runnerStop,
  runnerTask,
  seedMissingAssetState,
  seedSenderCache,
  setCopiedUser,
  setLastSeenUpdateId,
  setBusinessWorkerFatalHandler,
  setStatePersistenceFatalHandler,
  sleep,
  sweepManagedBlocklistChats,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
  testDependencies,
  triggerBusinessWorkerFatal,
  triggerDiskIOFatal,
} as const;

export type { FlushResult };
