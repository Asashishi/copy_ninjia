import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: string[] = [];
const acquireSingleInstanceLock = mock(async (): Promise<void> => { calls.push("acquireLock"); });
const releaseSingleInstanceLock = mock(async (): Promise<void> => { calls.push("releaseLock"); });
const getStickerConfig = mock((): object => ({}));
const getReactionConfig = mock((): object => ({}));
const initTelegramClients = mock((): void => { calls.push("initTelegram"); });
const initDiskIO = mock((): void => { calls.push("initDiskIO"); });
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
const flushDiskIO = mock(async (): Promise<void> => { calls.push("flushDiskIO"); });
const flushStateToDisk = mock(async (): Promise<void> => { calls.push("flushState"); });
const flushAiMemory = mock(async (): Promise<void> => { calls.push("flushAiMemory"); });
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
const loggerError = mock((..._args: unknown[]): void => {});
const getUpdates = mock(async (): Promise<unknown[]> => []);
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
const run = mock((_bot: unknown, _options: unknown) => runnerHandle);

mock.module("@grammyjs/runner", () => ({ run }));
mock.module("../../src/aiChat", () => ({
  flushAiMemory,
  hydrateAiMemory,
  hydrateStickerCatalog,
  initAiChat,
}));
mock.module("../../src/antiRaid", () => ({ hydratePendingVerifications, initAntiRaid }));
mock.module("../../src/commands", () => ({ restoreLuckState }));
mock.module("../../src/config/reactions", () => ({ getReactionConfig }));
mock.module("../../src/config/stickers", () => ({ getStickerConfig }));
mock.module("../../src/infra/chatTitle", () => ({ refreshAllChatTitles }));
mock.module("../../src/infra/config", () => ({ BOT_TOKEN: "test-token" }));
mock.module("../../src/infra/diskIO", () => ({ flushDiskIO, initDiskIO, loadPersistedData }));
mock.module("../../src/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerError,
  },
}));
mock.module("../../src/infra/storage/cleanup", () => ({ cleanupOrphanedTempFiles }));
mock.module("../../src/infra/storage/instanceLock", () => ({ acquireSingleInstanceLock, releaseSingleInstanceLock }));
mock.module("../../src/infra/storage/stateStore", () => ({
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  loadState,
}));
mock.module("../../src/infra/telegram", () => ({ bot, initTelegramClients }));
mock.module("../../src/libs/sleep", () => ({ sleep }));
mock.module("../../src/users/senderIdentity", () => ({ seedSenderCache }));
mock.module("../../src/app/commandMenu", () => ({ registerCommandMenu }));
mock.module("../../src/app/registerHandlers", () => ({ registerHandlers }));

const { ApplicationLifecycle } = await import("../../src/app/lifecycle");

beforeEach(() => {
  calls.length = 0;
  copiedUser = null;
  lastSeenUpdateId = 0;
  process.exitCode = 0;
  for (const mocked of [
    acquireSingleInstanceLock,
    releaseSingleInstanceLock,
    getStickerConfig,
    getReactionConfig,
    initTelegramClients,
    initDiskIO,
    cleanupOrphanedTempFiles,
    loadState,
    refreshAllChatTitles,
    loadPersistedData,
    flushDiskIO,
    flushStateToDisk,
    flushAiMemory,
    hydrateAiMemory,
    hydrateStickerCatalog,
    initAiChat,
    hydratePendingVerifications,
    initAntiRaid,
    restoreLuckState,
    seedSenderCache,
    registerCommandMenu,
    registerHandlers,
    sleep,
    loggerError,
    getUpdates,
    botInit,
    runnerStop,
    runnerTask,
    runnerSize,
    run,
  ]) mocked.mockClear();
  acquireSingleInstanceLock.mockImplementation(async (): Promise<void> => { calls.push("acquireLock"); });
  getStickerConfig.mockImplementation((): object => ({}));
  refreshAllChatTitles.mockImplementation(async (): Promise<void> => { calls.push("refreshTitles"); });
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
    const lifecycle = new ApplicationLifecycle();

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

  test("轮询任务异常后执行完整持久化顺序并只释放一次锁", async () => {
    runnerTask.mockRejectedValueOnce(new Error("polling failed"));
    copiedUser = { id: 7 };
    const lifecycle = new ApplicationLifecycle();

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
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(runnerStop).not.toHaveBeenCalled();
  });

  test("主动 dispose 会先停止仍在运行的 runner，再排空 AI、磁盘和状态", async () => {
    const lifecycle = new ApplicationLifecycle();
    await lifecycle.init();

    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("runnerStop")).toBeLessThan(calls.indexOf("flushAiMemory"));
  });

  test("正常 wait 会等待 runner 排空并确认最后 update offset", async () => {
    runnerSize.mockReturnValueOnce(1).mockReturnValue(0);
    lastSeenUpdateId = 321;
    const lifecycle = new ApplicationLifecycle();
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenCalledWith({ offset: 322, limit: 1, timeout: 0 });
    expect(flushAiMemory).toHaveBeenCalledTimes(2);
    expect(flushDiskIO).toHaveBeenCalledTimes(2);
    expect(flushStateToDisk).toHaveBeenCalledTimes(2);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });
});
