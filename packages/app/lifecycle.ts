import {
  EMERGENCY_FLUSH_TIMEOUTS,
  EMERGENCY_REUSED_DISPOSE_DEADLINE_MS,
  FINAL_OFFSET_CONFIRM_TIMEOUT_MS,
  NORMAL_FLUSH_TIMEOUTS,
  RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
  RUNNER_DRAIN_POLL_INTERVAL_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
} from "../consts/lifecycle";
import { TELEGRAM_ALLOWED_UPDATES } from "../consts/telegram";
import type { CachedUser } from "../types/chatState";
import type { LoadedData } from "../infra/diskIO";
import type { ApplicationLifecycleDependencies, FlushResult, FlushTimeouts } from "../types/lifecycle";
import type { HandlerRegistration } from "./registerHandlers";
import type { AcknowledgedUpdateRunner } from "./updateRunner";
import { lifecycleDependencies } from "./lifecycleDependencies";
import {
  createOwnerSettler,
  flushAllToDisk,
  formatShutdownResults,
  isCleanShutdown,
  runShutdownOwners,
} from "./lifecycle/shutdown";
import type { OwnerInitFlags, OwnerSettler, ShutdownResults } from "./lifecycle/shutdown";

/**
 * 持有应用从取得单实例锁到释放锁的完整生命周期。所有会联网、创建 Worker、
 * 注册进程 handler 或写盘的动作都由显式 init/run/dispose 驱动，模块导入本身
 * 不启动任何组件。
 * @see ../../docs/04-invariants.md
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
  private maintenanceQuiesced: boolean = false;
  private runnerCancellationUnsettled: boolean = false;
  /**
   * 最终 Telegram offset gate 的进程级闩锁。没有待确认 update 时保持 true；
   * wait() 一旦发现确认失败/超时或关键前置未完成，就永久置 false，后续 dispose
   * 不能因 owner 第二次恰好排空而把这次未确认伪装成干净停机。
   */
  private finalOffsetGateSucceeded: boolean = true;

  private readonly stopOnSignal = (): void => {
    this.stopRequested = true;
    this.quiesceMaintenance();
    this.runner?.stop().catch((error: unknown): void => {
      this.dependencies.logger.error("Error stopping runner:", error);
    });
  };

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
    this.dependencies.initReactionQueue();
    this.dependencies.initChatTitleRefresh();
    this.dependencies.initTranslate();
    this.flags.translateInitialized = true;

    // 配置文件属于不可信部署输入，但**不在这里统一预热**：那样一份写坏的贴纸
    // 白名单就能让 copy、抽奖、入群验证、黑名单——全部按群 opt-in 之外的核心
    // 能力——跟着离线，systemd 还会照着重启循环。校验挪到各功能自己的 enable
    // 分支（见 config/readiness.ts 与 commands/configGate.ts），坏了只拒绝那一个
    // 功能；各 Worker 在自己的 isolate 中复用同一解析器。
    await this.dependencies.cleanupOrphanedTempFiles();
    await this.dependencies.loadState();
    // 状态就绪、还没碰网络与 Worker 时核对一次：state.json 里还开着的可选功能，
    // 前提必须齐备。缺了就按老规矩拒绝启动——把管理员明确开过的功能悄悄降级成
    // 「静默不干活」，群里只会看到机器人从某次重启起再也不理人（见
    // app/featurePreflight.ts）。谁都没开的功能缺前提不在这里拦。
    this.dependencies.preflightEnabledFeatures();

    // state 主副本已经严格校验并建立 LKG 后，才创建运行时 Worker 和会安装
    // 心跳 timer 的 Telegram transformer；恢复失败不会留下半初始化组件。
    this.dependencies.initTelegramClients();
    this.dependencies.initDiskIO({ onFatal: this.handleDiskIOFatal });
    this.flags.diskIOInitialized = true;

    const loaded: LoadedData = await this.dependencies.loadPersistedData();
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
    this.dependencies.hydrateBlocklist(loaded.blockedUsers, loaded.pendingBlockedRemovals);
    this.dependencies.initAntiRaid();
    this.flags.antiRaidInitialized = true;

    this.dependencies.logger.log(
      `Bot started as @${this.dependencies.bot.botInfo.username}. ` +
      `Restored state for ${this.dependencies.getAllChatStates().size} chat(s)` +
      (restoredCopiedUser ? `, currently copying ${restoredCopiedUser.id}.` : ".")
    );

    this.runner = this.dependencies.runAcknowledgedUpdateBatches(
      this.dependencies.bot,
      TELEGRAM_ALLOWED_UPDATES
    );
    // 关键 Bot API 握手、Worker hydrate 和 runner 入口全部就绪后，才让低优先级
    // 标题维护进入共享 throttler；小并发池由 chatTitle owner 自己保证。
    this.chatTitleRefreshSettled = false;
    this.chatTitleRefreshTask = this.dependencies.refreshAllChatTitles()
      .catch((error: unknown): void => {
        this.dependencies.logger.error("Failed to complete chat title refresh:", error);
      })
      .finally((): void => { this.chatTitleRefreshSettled = true; });
    if (this.stopRequested) this.stopOnSignal();
  }

  /** 等待轮询停止、在途 update 排空、后台维护结束，并确认最终 update offset。 */
  async wait(): Promise<void> {
    const runner: AcknowledgedUpdateRunner | null = this.runner;
    if (runner === null) throw new Error("Application lifecycle has not been initialized");

    try {
      await runner.task();
    } finally {
      this.runnerTaskSettled = true;
    }
    const maintenanceQuiesceSucceeded: boolean = this.quiesceMaintenance();
    const runnerDrained: boolean = await this.waitForRunnerDrain(runner);

    // 标题刷新可能触发 saveStateInBackground；必须先等它完成，再做最终 flush。
    const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(
      NORMAL_FLUSH_TIMEOUTS.maintenanceMs
    );
    const persistenceFlushed: boolean = await this.flushAllToDisk(NORMAL_FLUSH_TIMEOUTS);
    if (!maintenanceQuiesceSucceeded || !runnerDrained || !maintenanceSettled) process.exitCode = 1;

    // 停机时取数循环会放弃在途批次、不再 await 它的汇总，那批里失败的 update
    // 只有 runner 的这个标记能证明（task() 会正常 resolve）。失败的 update 必须
    // 留给 Telegram 重投，绝不能被最终 offset 一起确认，见
    // docs/04-invariants.md「Telegram update 只有在对应 middleware 完成后才可
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
      const clean: boolean = isCleanShutdown(results);
      if (!clean) {
        process.exitCode = 1;
        this.dependencies.logger.error(`Shutdown drain/flush results: ${formatShutdownResults(results)}.`);
      }
      if (!this.lockAcquired) return;
      if (!clean) {
        this.dependencies.logger.error(
          "Retaining the single-instance lock until process exit because a task did not drain or persistence did not flush."
        );
        return;
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

  /** 生产运行入口：显式安装进程 handler，执行 init/wait，并保证 dispose。 */
  run(): Promise<void> {
    this.installProcessHandlers();
    return this.runMain()
      .catch((error: unknown): void => {
        this.dependencies.logger.error("Unhandled error in bot main runner:", error);
        process.exitCode = 1;
      })
      .finally(async (): Promise<void> => {
        await this.dispose();
        this.removeProcessHandlers();
        if (this.runnerCancellationUnsettled) process.exit(1);
      });
  }

  private async runMain(): Promise<void> {
    await this.init();
    await this.wait();
  }

  private installProcessHandlers(): void {
    if (this.processHandlersInstalled) return;
    // 信号 handler 要在第一个 await 之前安装；若信号在 runner 创建前到达，
    // stopRequested 会让 runner 一创建就立即停止。
    process.once("SIGINT", this.stopOnSignal);
    process.once("SIGTERM", this.stopOnSignal);
    process.on("uncaughtException", this.handleUncaughtException);
    process.on("unhandledRejection", this.handleUnhandledRejection);
    this.processHandlersInstalled = true;
  }

  private removeProcessHandlers(): void {
    if (!this.processHandlersInstalled) return;
    process.removeListener("SIGINT", this.stopOnSignal);
    process.removeListener("SIGTERM", this.stopOnSignal);
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
    runner: AcknowledgedUpdateRunner,
    timeoutMs: number = RUNNER_DRAIN_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline: number = Date.now() + timeoutMs;
    while (runner.size() > 0 && Date.now() < deadline) {
      await this.dependencies.sleep(RUNNER_DRAIN_POLL_INTERVAL_MS);
    }
    if (runner.size() > 0) {
      const activeAtDeadline: number = runner.size();
      this.dependencies.logger.error(
        `Shutdown drain still had ${activeAtDeadline} active update(s) after ${timeoutMs}ms; ` +
        "aborting them and withholding their Telegram offset."
      );
      runner.abortActive();
      const cancellationDeadline: number =
        Date.now() + RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS;
      while (runner.size() > 0 && Date.now() < cancellationDeadline) {
        await this.dependencies.sleep(RUNNER_DRAIN_POLL_INTERVAL_MS);
      }
      if (runner.size() > 0) {
        this.runnerCancellationUnsettled = true;
        this.dependencies.logger.error(
          `${runner.size()} update(s) ignored shutdown cancellation for ` +
          `${RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS}ms; forcing a failed process exit after best-effort flush.`
        );
      }
      return false;
    }
    return true;
  }

  private async waitForBackgroundMaintenance(timeoutMs: number): Promise<boolean> {
    const task: Promise<void> | null = this.chatTitleRefreshTask;
    if (task === null || this.chatTitleRefreshSettled) return true;
    if (timeoutMs <= 0) {
      // 没有等待窗口时也必须 abort：不变量要求预算耗尽后不得再写入群标题。
      this.dependencies.abortChatTitleRefresh();
      this.dependencies.logger.error("Skipping unfinished chat title refresh during emergency disposal; aborted it.");
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled: boolean = await Promise.race([
      task.then((): boolean => true),
      new Promise<boolean>((resolve: (value: boolean | PromiseLike<boolean>) => void): void => {
        timer = setTimeout((): void => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!settled) {
      this.dependencies.abortChatTitleRefresh();
      this.dependencies.logger.error(`Chat title refresh did not settle within ${timeoutMs}ms and was aborted.`);
    }
    return settled;
  }

  private quiesceMaintenance(): boolean {
    if (this.maintenanceQuiesced) return true;
    let succeeded: boolean = true;
    const quiesceOwner = (owner: string, run: () => void): void => {
      try {
        run();
      } catch (error: unknown) {
        succeeded = false;
        this.dependencies.logger.error(`Shutdown owner ${owner} quiesce threw during shutdown:`, error);
      }
    };
    // 每个入口独立结算：前一个 owner 抛错不能让后续入口继续接受新工作。
    // 只有全部成功才记为完成；否则下一次 wait/dispose 仍会重试，已成功的
    // quiesce 都是幂等赋值，可以安全重复。
    quiesceOwner("avatar", (): void => this.dependencies.quiesceAvatarUpdates());
    quiesceOwner("reaction", (): void => this.dependencies.quiesceReactionQueue());
    quiesceOwner("chat-title", (): void => this.dependencies.quiesceChatTitleRefresh());
    quiesceOwner("translate", (): void => this.dependencies.quiesceTranslate());
    this.maintenanceQuiesced = succeeded;
    return succeeded;
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
