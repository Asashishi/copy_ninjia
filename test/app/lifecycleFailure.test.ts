import { describe, expect, spyOn, test } from "bun:test";
import {
  EMERGENCY_FLUSH_TIMEOUTS,
  EMERGENCY_REUSED_DISPOSE_DEADLINE_MS,
} from "../../packages/consts/lifecycle";
import {
  installLifecycleFixtureHooks,
  lifecycleFixture as sharedFixture,
} from "../helpers/lifecycleFixture";
import type { FlushResult } from "../helpers/lifecycleFixture";

const {
  ApplicationLifecycle,
  abortChatTitleRefresh,
  acquireSingleInstanceLock,
  botInit,
  calls,
  cleanupOrphanedTempFiles,
  closeTranslate,
  deferred,
  drainAntiRaid,
  drainAvatarUpdates,
  drainGagRuntime,
  drainTelegramOutbound,
  drainTranslate,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  hydrateAiMemory,
  hydrateBlocklist,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAiChat,
  initDiskIO,
  initTelegramClients,
  initTranslate,
  loadPersistedData,
  loadState,
  loggerLog,
  loggerError,
  validateExistingDeploymentInputs,
  quiesceAvatarUpdates,
  quiesceChatTitleRefresh,
  quiesceGagRuntime,
  quiesceTranslate,
  realDrainDependencies,
  refreshAllChatTitles,
  registerHandlers,
  releaseSingleInstanceLock,
  runnerStop,
  runnerTask,
  seedMissingAssetState,
  seedSenderCache,
  setCopiedUser,
  setBusinessWorkerFatalHandler,
  setStatePersistenceFatalHandler,
  testDependencies,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
  triggerBusinessWorkerFatal,
  triggerDiskIOFatal,
} = sharedFixture;

installLifecycleFixtureHooks();

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

  test("回归用例：启动期到达的停止信号不能把 quiesce 一次性闩死", async () => {
    // 取锁期间收到 SIGTERM：这次 quiesce 发生在 init 用 initAvatarUpdates 等四个
    // 入口把 owner 重新武装**之前**，把它记成「已经 quiesce 完了」就等于此后
    // wait()/dispose() 的每一次调用都被短路——四个 owner 整个停机期间继续收活，
    // 而停机结果照报 maintenance=true，最终 offset 照常确认，日志里什么都看不出来。
    acquireSingleInstanceLock.mockImplementationOnce(async (): Promise<void> => {
      calls.push("acquireLock");
      process.emit("SIGTERM");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();

    // init 尾部那次重新收口之后，wait()/dispose() 仍会各自再 quiesce 一遍。
    expect(quiesceAvatarUpdates.mock.calls.length).toBeGreaterThan(1);
    expect(quiesceTranslate.mock.calls.length).toBeGreaterThan(1);
    // 标题刷新只在入口同步查一次 accepting，因此重新收口必须排在它启动之前，
    // 否则「已经要求停机」之后照样跑完整轮 getChat 扫描加批量落盘。
    expect(calls.indexOf("quiesceTitles")).toBeGreaterThan(-1);
    expect(calls.indexOf("quiesceTitles")).toBeLessThan(calls.indexOf("refreshTitles"));
    const signalLogs: unknown[][] = loggerLog.mock.calls.filter(
      (args: unknown[]): boolean => args[0] === "Received SIGTERM; beginning graceful shutdown."
    );
    expect(signalLogs).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  test("正常运行收到 SIGINT 时记录原因并保持干净停机", async () => {
    runnerTask.mockImplementationOnce(async (): Promise<void> => {
      process.emit("SIGINT");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();

    expect(loggerLog).toHaveBeenCalledWith("Received SIGINT; beginning graceful shutdown.");
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  test("SQLite 恢复缺少表计数时拒绝启动 Telegram handler", async () => {
    loadPersistedData.mockResolvedValueOnce({
      aiMemories: new Map<number, string>(),
      stickerCatalogs: new Map<string, string>(),
      luckDay: null,
      luckReceiptSecret: { day: "2026-07-19", secret: "test-secret" },
      verifications: new Map<string, never>(),
      pendingBlockedRemovals: new Map(),
    } as never);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(initDiskIO).toHaveBeenCalledTimes(1);
    expect(registerHandlers).not.toHaveBeenCalled();
    expect(botInit).not.toHaveBeenCalled();
    expect(hydrateBlocklist).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("state 与部署输入校验完成后才初始化 Telegram 和 Disk I/O Worker", async () => {
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    expect(calls.indexOf("cleanupTemps")).toBeLessThan(calls.indexOf("loadState"));
    expect(calls.indexOf("loadState")).toBeLessThan(
      calls.indexOf("validateDeploymentInputs")
    );
    expect(calls.indexOf("validateDeploymentInputs")).toBeLessThan(
      calls.indexOf("initDiskIO")
    );
    expect(calls.indexOf("initDiskIO")).toBeLessThan(calls.indexOf("initTelegram"));
    expect(calls.indexOf("initDiskIO")).toBeLessThan(calls.indexOf("hydrateIdentityCounts"));
    expect(calls.indexOf("hydrateIdentityCounts")).toBeLessThan(calls.indexOf("botInit"));
    // 补齐素材直链读的是 loadState 恢复出来的内存，且必须排在**所有**会拒绝启动的
    // await 之后（部署输入闸、bot.init、黑名单补扫）——被拒绝启动的那次运行不该顺手
    // 改写运维正要拿去排查的 state.json。
    expect(calls.indexOf("loadState")).toBeLessThan(calls.indexOf("seedAssets"));
    expect(calls.indexOf("validateDeploymentInputs")).toBeLessThan(
      calls.indexOf("seedAssets")
    );
    expect(calls.indexOf("botInit")).toBeLessThan(calls.indexOf("seedAssets"));
    expect(calls.indexOf("sweepBlocklist")).toBeLessThan(calls.indexOf("seedAssets"));
    expect(hydrateBlocklist).toHaveBeenCalledWith(expect.any(Map));
    expect(calls.indexOf("initAntiRaid")).toBeLessThan(
      calls.indexOf("initBlocklistScheduler")
    );
    expect(calls.indexOf("initBlocklistScheduler")).toBeLessThan(
      calls.indexOf("sweepBlocklist")
    );
    expect(calls.indexOf("sweepBlocklist")).toBeLessThan(
      calls.indexOf("runUpdates")
    );
    expect(calls.indexOf("botInit")).toBeLessThan(calls.indexOf("runUpdates"));
    expect(calls.indexOf("runUpdates")).toBeLessThan(calls.indexOf("refreshTitles"));
    await lifecycle.dispose();
    expect(calls.indexOf("quiesceBlocklistScheduler")).toBeLessThan(
      calls.indexOf("drainAntiRaid")
    );
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

  test("部署输入闸拒绝时不补齐素材直链，state.json 保持运维看到的原样", async () => {
    // 补齐是纯可读性写入；被拒绝启动的那次运行改写 state.json 只会干扰排查。
    validateExistingDeploymentInputs.mockImplementationOnce((): void => {
      calls.push("validateDeploymentInputs");
      throw new Error("config/mood.json: $ must match its current schema");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(seedMissingAssetState).not.toHaveBeenCalled();
    expect(initTelegramClients).not.toHaveBeenCalled();
    expect(initDiskIO).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("部署输入闸之后的启动拒绝同样不补齐——bot.init 失败也不改写 state.json", async () => {
    // 部署输入闸不是最后一道拒绝点：吊销的 token 要到 bot.init 才炸。补齐排在所有
    // 会中止启动的 await 之后，这条路径才守得住「被拒绝的启动不动运维的文件」。
    botInit.mockImplementationOnce(async (): Promise<never> => {
      calls.push("botInit");
      throw new Error("401: Unauthorized");
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.run();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(calls).toContain("botInit");
    expect(seedMissingAssetState).not.toHaveBeenCalled();
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("启动全程成功后才补齐素材直链，并按补写项数留一行日志", async () => {
    seedMissingAssetState.mockImplementationOnce((): number => {
      calls.push("seedAssets");
      return 2;
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.init();
    await lifecycle.dispose();

    // 排在最后一个会拒绝启动的 await（黑名单补扫）之后。
    expect(calls.indexOf("seedAssets")).toBeGreaterThan(calls.indexOf("sweepBlocklist"));
    expect(testDependencies.logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Seeded 2 missing state.global.assets URL(s)")
    );
  });

  test("轮询任务异常后执行完整持久化顺序，报未确认 offset 但照常释放实例锁", async () => {
    runnerTask.mockRejectedValueOnce(new Error("polling failed"));
    setCopiedUser({ id: 7 });
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
    expect(runnerStop).not.toHaveBeenCalled();
    // task() 抛错会让整段确认前闸门被跳过。闸门标记若停在初始值 true，dispose()
    // 组装出的 offsetConfirmed 就是真，这一轮会被判成干净停机：诊断行不输出，
    // 运维 grep 日志看到的是「一切正常」，实际丢了一条更新且扣住了 offset。
    // 跳过 = 记为失败（见 docs/cn/04-invariants.md）。
    expect(process.exitCode).toBe(1);
    const errorLines: string[] = loggerError.mock.calls.map((call: unknown[]): string => String(call[0]));
    expect(errorLines.some((line: string): boolean =>
      line.startsWith("Shutdown drain/flush results:") && line.includes("offset=false")
    )).toBeTrue();
    // 但这一档只是 offset 没确认：runner 已排空、各 owner 已 flush、Worker 已
    // terminate，没有任何东西还会写共享数据目录，锁必须照常释放。扣住锁会留下
    // 一条陈旧的 bot.lock 记录，并把运维引向根本没坏的 Worker 和磁盘。
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(errorLines.some((line: string): boolean =>
      line.startsWith("Releasing the single-instance lock even though")
    )).toBeTrue();
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
    expect(quiesceGagRuntime).toHaveBeenCalledTimes(1);
    expect(drainTranslate).toHaveBeenCalledTimes(1);
    expect(closeTranslate).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("runnerStop")).toBeLessThan(calls.indexOf("flushAiMemory"));
    expect(calls.indexOf("quiesceTranslate")).toBeLessThan(calls.indexOf("drainTranslate"));
    expect(calls.indexOf("drainTranslate")).toBeLessThan(calls.indexOf("closeTranslate"));
    expect(calls.indexOf("drainGag")).toBeLessThan(calls.indexOf("drainTelegramOutbound"));
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
    expect(calls.indexOf("drainAntiRaid")).toBeLessThan(calls.indexOf("drainMessageDeletions"));
    expect(calls.indexOf("drainMessageDeletions")).toBeLessThan(calls.indexOf("flushAiMemory"));
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

    expect(quiesceChatTitleRefresh).toHaveBeenCalledTimes(1);
    expect(quiesceTranslate).toHaveBeenCalledTimes(1);
    expect(drainAvatarUpdates).toHaveBeenCalledTimes(1);
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

  test("Telegram 总闸排空失败仍继续落盘和终止，但不得释放实例锁", async () => {
    drainTelegramOutbound.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(terminateAntiRaid).toHaveBeenCalledTimes(1);
    expect(terminateDiskIO).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("telegram=failed"));
  });

  test("gag 提示未清理时仍继续后续 owner，但不得释放实例锁", async () => {
    drainGagRuntime.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.dispose();

    expect(drainTelegramOutbound).toHaveBeenCalledTimes(1);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("gag=failed"));
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

    triggerDiskIOFatal(new Error("runtime recovery failed"));
    await lifecycle.wait();

    // 最终 offset 的确认前排空必须先关掉补扫生产者；等到 dispose() 才关会让
    // timer 在本轮 anti-raid drain 之后重新登记网络任务与 outbox 写入。
    expect(calls.indexOf("quiesceBlocklistScheduler")).toBeLessThan(
      calls.indexOf("drainAntiRaid")
    );
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

    triggerBusinessWorkerFatal(new Error("AI Worker replay failed"));
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

});
