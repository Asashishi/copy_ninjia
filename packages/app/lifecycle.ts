import {
  EMERGENCY_FLUSH_TIMEOUTS,
  EMERGENCY_REUSED_DISPOSE_DEADLINE_MS,
  FINAL_OFFSET_CONFIRM_TIMEOUT_MS,
  NORMAL_FLUSH_TIMEOUTS,
} from "../consts/lifecycle";
import { TELEGRAM_ALLOWED_UPDATES } from "../consts/telegram";
import type { CachedUser } from "../types/chatState";
import type { LoadedData } from "../types/diskIO/replies";
import type {
  AcknowledgedUpdateRunner,
  ApplicationRunMode,
  FlushResult,
  FlushTimeouts,
  HandlerRegistration,
  OwnerInitFlags,
  OwnerSettler,
  ShutdownOutcome,
  ShutdownResults,
} from "../types/lifecycle";
import { lifecycleDependencies } from "./lifecycleDependencies";
import type { ApplicationLifecycleDependencies } from "./lifecycleDependencies";
import {
  classifyShutdown,
  createOwnerSettler,
  flushAllToDisk,
  formatShutdownResults,
  runShutdownOwners,
} from "./lifecycle/shutdown";
import {
  drainAcknowledgedUpdateRunner,
  quiesceLifecycleMaintenance,
  waitForLifecycleBackgroundMaintenance,
} from "./lifecycle/maintenance";

type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * 持有应用从取得单实例锁到释放锁的完整生命周期。所有会联网、创建 Worker、
 * 注册进程 handler 或写盘的动作都由显式 init/run/dispose 驱动，模块导入本身
 * 不启动任何组件。
 * @see ../../docs/cn/04-invariants.md
 */
export class ApplicationLifecycle {
  constructor(private readonly dependencies: ApplicationLifecycleDependencies = lifecycleDependencies) {}

  private lockAcquired: boolean = false;
  // 各 owner 的初始化标志交给停机序列就地读写（见 lifecycle/shutdown.ts）：
  // 终止过的 owner 会被置回 false，避免重复终止。
  private readonly flags: OwnerInitFlags = {
    aiChatInitialized: false,
    antiRaidInitialized: false,
    diskIOInitialized: false,
    translateInitialized: false,
  };
  private stopRequested: boolean = false;
  private runner: AcknowledgedUpdateRunner | null = null;
  private runnerTaskSettled: boolean = false;
  private handlers: HandlerRegistration | null = null;
  private chatTitleRefreshTask: Promise<void> | null = null;
  private chatTitleRefreshSettled: boolean = true;
  private disposePromise: Promise<void> | null = null;
  private processHandlersInstalled: boolean = false;
  private fatalExitStarted: boolean = false;
  private runnerCancellationUnsettled: boolean = false;
  /**
   * 最终 Telegram offset gate 的进程级闩锁。没有待确认 update 时保持 true；
   * wait() 一旦发现确认失败/超时或关键前置未完成，就永久置 false，后续 dispose
   * 不能因 owner 第二次恰好排空而把这次未确认伪装成干净停机。
   */
  private finalOffsetGateSucceeded: boolean = true;

  private stopAfterSignal(): void {
    this.stopRequested = true;
    this.quiesceMaintenance();
    this.runner?.stop().catch((error: unknown): void => {
      this.dependencies.logger.error("Error stopping runner:", error);
    });
  }

  private stopOnSignal(signal: ShutdownSignal): void {
    if (!this.stopRequested) {
      this.dependencies.logger.log(`Received ${signal}; beginning graceful shutdown.`);
    }
    this.stopAfterSignal();
  }

  private readonly stopOnSigint = (): void => { this.stopOnSignal("SIGINT"); };
  private readonly stopOnSigterm = (): void => { this.stopOnSignal("SIGTERM"); };

  private readonly handleUncaughtException = (error: unknown): void => {
    this.dependencies.logger.error("Uncaught exception, attempting a best-effort flush before exit:", error);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleUnhandledRejection = (reason: unknown): void => {
    this.dependencies.logger.error("Unhandled rejection, attempting a best-effort flush before exit:", reason);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleDiskIOFatal = (error: Error): void => {
    this.dependencies.logger.error("Persistence became unavailable at runtime; stopping for a supervised restart:", error);
    process.exitCode = 1;
    this.stopRequested = true;
    this.quiesceMaintenance();
    this.runner?.stop().catch((stopError: unknown): void => {
      this.dependencies.logger.error("Error stopping runner after persistence failure:", stopError);
    });
  };

  private readonly handleBusinessWorkerFatal = (error: Error): void => {
    this.dependencies.logger.error(
      "Business Worker became unavailable at runtime; stopping for a supervised restart:",
      error
    );
    process.exitCode = 1;
    this.stopRequested = true;
    this.quiesceMaintenance();
    this.runner?.stop().catch((stopError: unknown): void => {
      this.dependencies.logger.error("Error stopping runner after business Worker failure:", stopError);
    });
  };

  /** 初始化各组件并开始长轮询；重复调用会被拒绝。 */
  async init(): Promise<void> {
    if (this.runner !== null || this.lockAcquired) throw new Error("Application lifecycle is already initialized");

    await this.dependencies.acquireSingleInstanceLock(this.dependencies.BOT_TOKEN);
    this.lockAcquired = true;
    this.dependencies.setBusinessWorkerFatalHandler(this.handleBusinessWorkerFatal);
    this.dependencies.setStatePersistenceFatalHandler(this.handleDiskIOFatal);
    this.dependencies.initAvatarUpdates();
    this.dependencies.initChatTitleRefresh();
    this.dependencies.initTranslate();
    this.dependencies.initGagRuntime();
    this.dependencies.initWedRuntime();
    this.flags.translateInitialized = true;

    // 配置文件和持久化状态都是不可信部署输入。已有部署输入不受功能开关影响，
    // 各 Worker 在自己的 isolate 中复用同一严格解析器。
    await this.dependencies.cleanupOrphanedTempFiles();
    await this.dependencies.loadState();
    await this.dependencies.validateExistingDeploymentInputs();
    // global state 主副本与部署输入都通过严格校验后，才创建本地 Disk I/O Worker。
    // SQLite 群状态只负责恢复运行时开关，不再沿用 state.json 时代的功能前提或
    // 数据正确性启动总闸；功能命令和消息入口各自在 readiness 边界拒绝不可用配置。
    this.dependencies.initDiskIO({ onFatal: this.handleDiskIOFatal });
    this.flags.diskIOInitialized = true;

    const loaded: LoadedData = await this.dependencies.loadPersistedData();
    if (
      loaded.blocklistEntryCount === undefined ||
      loaded.whitelistEntryCount === undefined
    ) {
      throw new Error("Identity database recovery did not return both policy table counts.");
    }
    this.dependencies.hydrateChatStateCache(loaded.chatStates);
    this.dependencies.hydrateChatQaCache(loaded.chatQa);
    this.dependencies.hydrateWedMembers(loaded.wedMembers);
    this.dependencies.initTelegramClients();
    this.dependencies.hydrateIdentityStorageCounts(
      loaded.whitelistEntryCount,
      loaded.blocklistEntryCount
    );
    // 超管与黑名单必须互斥。这条断言只能排在 hydrate 之后（它会清空三份 LRU）、
    // 且必须早于 sweepManagedBlocklistChats——否则一个指向历史 /block 账号的
    // super_admin_user_id 会让本进程把新超管从所有托管群里清出去，而他连一条
    // /unblock 都发不出来（理由见 infra/blocklist/membership.ts）。
    await this.dependencies.assertSuperAdminNotBlocked(
      this.dependencies.SUPER_ADMIN_USER_ID
    );
    const restoredCopiedUser: CachedUser | null = this.dependencies.getGlobalCopyState().copiedUser;
    if (restoredCopiedUser) this.dependencies.seedSenderCache(restoredCopiedUser);

    this.handlers = this.dependencies.registerHandlers(this.dependencies.bot);
    await this.dependencies.registerCommandMenu(this.dependencies.bot);
    await this.dependencies.bot.init();

    this.dependencies.initAiChat(this.dependencies.bot.botInfo);
    this.flags.aiChatInitialized = true;
    this.dependencies.hydrateAiMemory(loaded.aiMemories);
    this.dependencies.hydrateStickerCatalog(loaded.stickerCatalogs);
    this.dependencies.restoreLuckState(loaded.luckReceiptSecret, loaded.luckDay);
    this.dependencies.hydratePendingVerifications(loaded.verifications);
    // 必须早于 runner 开始投喂更新：启动瞬间进群的黑名单用户要能立刻被认出来。
    this.dependencies.hydrateBlocklist(loaded.pendingBlockedRemovals);
    this.dependencies.initAntiRaid();
    this.flags.antiRaidInitialized = true;
    this.dependencies.initBlocklistSweepScheduler();
    // SQLite 黑名单身份未必已有对应 outbox；在 runner 接收新 update 前，对
    // 所有已初始化且已确证管理员的群补一轮，频道 ID 会由 Worker 走封发言权路径。
    await this.dependencies.sweepManagedBlocklistChats();

    // 素材直链只能手工编辑，缺省时又整块不出现在文件里。把没设过的项按内置常量
    // 补进 state 并后台落盘，改图的人打开 state.json 就能看到当前生效值（见
    // infra/storage/stateStore.ts 的 seedMissingAssetState）。补写不阻塞启动。
    //
    // 排在**最后一个会拒绝启动的 await 之后**：部署输入闸、持久化恢复、bot.init 与
    // 黑名单补扫都可能中止这次启动，而被拒绝的那次运行不该顺手改写运维正要拿去
    // 排查的 state.json——只排在部署输入闸之后是守不住这句话的。
    //
    // 确有补写就记一行：改的是部署方的文件，logs/ 里不能只字不提（见
    // AGENTS.md 的数据归属）。
    const seededAssetUrls: number = this.dependencies.seedMissingAssetState();
    if (seededAssetUrls > 0) {
      this.dependencies.logger.log(
        `Seeded ${seededAssetUrls} missing state.global.assets URL(s) with built-in defaults; ` +
        "state.json and its backup are being rewritten in the background."
      );
    }

    this.dependencies.logger.log(
      `Bot started as @${this.dependencies.bot.botInfo.username}. ` +
      `Restored state for ${this.dependencies.getChatStateCache().size} chat(s)` +
      (restoredCopiedUser ? `, currently copying ${restoredCopiedUser.id}.` : ".")
    );

    this.runner = this.dependencies.runAcknowledgedUpdateBatches(
      this.dependencies.bot,
      TELEGRAM_ALLOWED_UPDATES
    );
    // 启动期到达的停止信号必须在这里重新收口：它触发的那次 quiesce 发生在
    // init 前段，而上面的 initAvatarUpdates/
    // initChatTitleRefresh/initTranslate/initGagRuntime/initBlocklistSweepScheduler 又把五个
    // owner 重新置为接受工作。
    // 位置也要卡在标题刷新之前——refreshAllChatTitles 只在入口同步检查一次
    // accepting，晚一步 quiesce 就等于在已经要求停机之后，照样跑完整轮
    // getChat 扫描加批量落盘。
    if (this.stopRequested) this.stopAfterSignal();
    // 关键 Bot API 握手、Worker hydrate 和 runner 入口全部就绪后，才让低优先级
    // 标题维护进入 Telegram query 类别的 429 队列；小并发池由 chatTitle owner 自己保证。
    this.chatTitleRefreshSettled = false;
    this.chatTitleRefreshTask = this.dependencies.refreshAllChatTitles()
      .catch((error: unknown): void => {
        this.dependencies.logger.error("Failed to complete chat title refresh:", error);
      })
      .finally((): void => { this.chatTitleRefreshSettled = true; });
  }

  /** 等待轮询停止、在途 update 排空、后台维护结束，并确认最终 update offset。 */
  async wait(): Promise<void> {
    const runner: AcknowledgedUpdateRunner | null = this.runner;
    if (runner === null) throw new Error("Application lifecycle has not been initialized");

    try {
      await runner.task();
    } catch (error: unknown) {
      // task() 抛错会让下面整段「确认最终 offset」的闸门被整体跳过，而
      // finalOffsetGateSucceeded 还停在初始值 true。dispose() 用它组装
      // ShutdownResults.offsetConfirmed，于是 classifyShutdown 判成 "clean"：
      // 诊断行不输出，运维 grep 日志看到的是「一切正常」，实际这轮既没走确认、
      // 也丢了一条更新，重启后的重复投递无从溯源。异常路径必须自己把闸门标记
      // 按下去，让它落进 "offsetWithheld"。
      this.finalOffsetGateSucceeded = false;
      throw error;
    } finally {
      this.runnerTaskSettled = true;
    }
    const maintenanceQuiesceSucceeded: boolean = this.quiesceMaintenance();
    const runnerDrained: boolean = await this.waitForRunnerDrain(runner);

    // 标题刷新可能排入 chatState SQLite 写缓冲；必须先等它完成，再做最终 flush。
    const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(
      NORMAL_FLUSH_TIMEOUTS.maintenanceMs
    );
    const persistenceFlushed: boolean = await this.flushAllToDisk(NORMAL_FLUSH_TIMEOUTS);
    if (!maintenanceQuiesceSucceeded || !runnerDrained || !maintenanceSettled) process.exitCode = 1;

    // 停机时取数循环会放弃在途 update、不再 await 它的结算，随后发生的失败
    // 只有 runner 的这个标记能证明（task() 会正常 resolve）。失败的 update 必须
    // 留给 Telegram 重投，绝不能被最终 offset 一起确认，见
    // docs/cn/04-invariants.md「Telegram update 只有在对应 middleware 完成后才可
    // 推进确认边界」。读在 waitForRunnerDrain 之后：标记与 size() 归零同步。
    const failedUpdateWithheld: boolean = runner.hasFailedUpdate();
    if (failedUpdateWithheld) {
      process.exitCode = 1;
      this.dependencies.logger.error(
        "Withholding the final Telegram offset: at least one update failed and must be redelivered after restart."
      );
    }
    const lastSeenUpdateId: number = this.handlers?.getLastSeenUpdateId() ?? 0;
    const confirmationPrerequisitesMet: boolean =
      maintenanceQuiesceSucceeded &&
      runnerDrained &&
      maintenanceSettled &&
      persistenceFlushed &&
      !failedUpdateWithheld;
    if (lastSeenUpdateId > 0 && confirmationPrerequisitesMet) {
      try {
        await this.dependencies.bot.api.getUpdates(
          { offset: lastSeenUpdateId + 1, limit: 1, timeout: 0 },
          AbortSignal.timeout(FINAL_OFFSET_CONFIRM_TIMEOUT_MS) as unknown as
            Parameters<typeof this.dependencies.bot.api.getUpdates>[1]
        );
      } catch (error: unknown) {
        this.finalOffsetGateSucceeded = false;
        process.exitCode = 1;
        this.dependencies.logger.error("Failed to confirm update offset on shutdown:", error);
      }
    } else if (lastSeenUpdateId > 0) {
      this.finalOffsetGateSucceeded = false;
      process.exitCode = 1;
      this.dependencies.logger.error(
        "Withholding the final Telegram offset because a shutdown prerequisite did not settle cleanly."
      );
    }
  }

  /** 停止活动 runner，等待后台任务完成，排空持久化并释放单实例锁。 */
  dispose(timeouts: FlushTimeouts = NORMAL_FLUSH_TIMEOUTS): Promise<void> {
    this.disposePromise ??= (async (): Promise<void> => {
      const settler: OwnerSettler = createOwnerSettler(this.dependencies.logger);
      const maintenanceQuiesceSucceeded: boolean = this.quiesceMaintenance();
      const runner: AcknowledgedUpdateRunner | null = this.runner;
      if (runner !== null && !this.runnerTaskSettled) {
        await runner.stop().catch((error: unknown): void => {
          this.dependencies.logger.error("Error stopping runner during disposal:", error);
        });
      }
      const runnerDrained: boolean = runner === null
        ? true
        : await settler.gate("runner drain", (): Promise<boolean> => this.waitForRunnerDrain(runner));
      const backgroundMaintenanceSettled: boolean = await settler.gate(
        "background maintenance",
        (): Promise<boolean> => this.waitForBackgroundMaintenance(timeouts.maintenanceMs)
      );
      const results: ShutdownResults = {
        runnerDrained,
        maintenanceSettled: maintenanceQuiesceSucceeded && backgroundMaintenanceSettled,
        offsetConfirmed: this.finalOffsetGateSucceeded,
        ...await runShutdownOwners({
          dependencies: this.dependencies,
          flags: this.flags,
          settler,
          timeouts,
          lockAcquired: this.lockAcquired,
        }),
      };
      try {
        this.dependencies.setBusinessWorkerFatalHandler(undefined);
        this.dependencies.setStatePersistenceFatalHandler(undefined);
      } catch (error: unknown) {
        this.dependencies.logger.error("Shutdown owner fatal-handler teardown threw during disposal:", error);
      }
      // 三态而不是「干净 / 不干净」：诊断与「能不能释放实例锁」是两个问题。
      // 非 clean 一律报非零退出并打印诊断行；但只有「可能还有人在写共享数据」
      // 那一档才扣住锁（见 lifecycle/shutdown.ts 的 classifyShutdown）。
      const outcome: ShutdownOutcome = classifyShutdown(results);
      if (outcome !== "clean") {
        process.exitCode = 1;
        this.dependencies.logger.error(`Shutdown drain/flush results: ${formatShutdownResults(results)}.`);
      }
      if (!this.lockAcquired) return;
      if (outcome === "unsettled") {
        this.dependencies.logger.error(
          "Retaining the single-instance lock until process exit because a task did not drain or persistence did not flush."
        );
        return;
      }
      if (outcome === "offsetWithheld") {
        // 锁照常释放：所有 owner 都已排空落盘、Worker 已终止，没有任何东西还会
        // 写共享数据目录。留一行说清楚这次释放不代表 offset 也确认过了——重启后
        // Telegram 会重投上次确认点之后的更新。
        this.dependencies.logger.error(
          "Releasing the single-instance lock even though the final Telegram offset was not confirmed: " +
          "every owner drained and flushed, so expect redelivery after restart rather than a persistence problem."
        );
      }
      const released: FlushResult = await settler.terminate(
        "single-instance lock release",
        (): Promise<void> => this.dependencies.releaseSingleInstanceLock(this.dependencies.BOT_TOKEN)
      );
      if (released !== "flushed") {
        process.exitCode = 1;
        return;
      }
      this.lockAcquired = false;
    })();
    return this.disposePromise;
  }

  /**
   * 执行 init/wait 并保证 dispose。main 模式额外接管进程 handler
   * 与退出码；test 模式把运行异常原样交还调用方。
   */
  async run(mode: ApplicationRunMode): Promise<void> {
    const managesProcess: boolean = mode === "main";
    if (managesProcess) this.installProcessHandlers();

    try {
      await this.runMain();
    } catch (error: unknown) {
      if (!managesProcess) throw error;
      this.dependencies.logger.error("Unhandled error in bot main runner:", error);
      process.exitCode = 1;
    } finally {
      await this.dispose();
      if (managesProcess) {
        this.removeProcessHandlers();
        if (this.runnerCancellationUnsettled) process.exit(1);
      }
    }
  }

  private async runMain(): Promise<void> {
    await this.init();
    await this.wait();
  }

  private installProcessHandlers(): void {
    if (this.processHandlersInstalled) return;
    // 信号 handler 要在第一个 await 之前安装；若信号在 runner 创建前到达，
    // stopRequested 会让 runner 一创建就立即停止。
    process.once("SIGINT", this.stopOnSigint);
    process.once("SIGTERM", this.stopOnSigterm);
    process.on("uncaughtException", this.handleUncaughtException);
    process.on("unhandledRejection", this.handleUnhandledRejection);
    this.processHandlersInstalled = true;
  }

  private removeProcessHandlers(): void {
    if (!this.processHandlersInstalled) return;
    process.removeListener("SIGINT", this.stopOnSigint);
    process.removeListener("SIGTERM", this.stopOnSigterm);
    process.removeListener("uncaughtException", this.handleUncaughtException);
    process.removeListener("unhandledRejection", this.handleUnhandledRejection);
    this.processHandlersInstalled = false;
  }

  private exitAfterEmergencyDispose(): void {
    if (this.fatalExitStarted) return;
    this.fatalExitStarted = true;
    const reusesActiveDisposal: boolean = this.disposePromise !== null;
    let exitRequested: boolean = false;
    let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const exitWithFailure = (): void => {
      if (exitRequested) return;
      exitRequested = true;
      process.exit(1);
    };

    // disposePromise 会固定首次调用的预算：普通关停已在途时，传入紧急预算
    // 无法缩短它。因此仅在复用分支设置独立绝对截止，避免二次扫描把新建的
    // 紧急 dispose（其各阶段已有短预算）误判为同一问题。该 timer 刻意保持
    // ref，确保清理卡死时仍能执行最后的强制退出。
    if (reusesActiveDisposal) {
      hardDeadlineTimer = setTimeout((): void => {
        this.dependencies.logger.error(
          `Emergency shutdown exceeded the ${EMERGENCY_REUSED_DISPOSE_DEADLINE_MS}ms hard deadline; forcing exit.`
        );
        exitWithFailure();
      }, EMERGENCY_REUSED_DISPOSE_DEADLINE_MS);
    }

    void this.dispose(EMERGENCY_FLUSH_TIMEOUTS).finally((): void => {
      if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
      exitWithFailure();
    });
  }

  private async waitForRunnerDrain(
    runner: AcknowledgedUpdateRunner
  ): Promise<boolean> {
    const result: "drained" | "aborted" | "unsettled" =
      await drainAcknowledgedUpdateRunner(runner, this.dependencies);
    if (result === "unsettled") this.runnerCancellationUnsettled = true;
    return result === "drained";
  }

  private async waitForBackgroundMaintenance(timeoutMs: number): Promise<boolean> {
    const task: Promise<void> | null = this.chatTitleRefreshTask;
    if (task === null || this.chatTitleRefreshSettled) return true;
    return waitForLifecycleBackgroundMaintenance(task, timeoutMs, this.dependencies);
  }

  /**
   * 让后台/临时状态 owner 停止接受新工作。**不闩锁「已经 quiesce 过」**：
   * init() 里的各 init 会把 accepting 重新置真，启动期到达的停止信号若把成功
   * 记成一次性完成，此后 wait()/dispose() 的每一次调用都会被短路——owner
   * 整个停机期间继续收活，
   * 而 maintenanceQuiesceSucceeded 仍报 true，最终 offset 照常确认，停机诊断里
   * 一点痕迹都没有。各调用都是幂等赋值，重复执行不花什么代价。
   */
  private quiesceMaintenance(): boolean {
    return quiesceLifecycleMaintenance(this.dependencies);
  }

  private flushAllToDisk(timeouts: FlushTimeouts): Promise<boolean> {
    if (!this.lockAcquired) return Promise.resolve(false);
    return flushAllToDisk({
      dependencies: this.dependencies,
      flags: this.flags,
      settler: createOwnerSettler(this.dependencies.logger),
      timeouts,
    });
  }
}

export function createApplicationLifecycle(): ApplicationLifecycle {
  return new ApplicationLifecycle();
}
