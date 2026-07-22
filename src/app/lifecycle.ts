import {
  EMERGENCY_FLUSH_TIMEOUTS,
  NORMAL_FLUSH_TIMEOUTS,
  RUNNER_DRAIN_POLL_INTERVAL_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
  type FlushTimeouts,
  type FlushResult,
} from "../consts/lifecycle";
import { TELEGRAM_ALLOWED_UPDATES } from "../consts/telegram";
import type { CachedUser } from "../types/chatState";
import type { LoadedData } from "../infra/diskIO";
import type { ApplicationLifecycleDependencies } from "../types/lifecycle";
import type { HandlerRegistration } from "./registerHandlers";
import type { AcknowledgedUpdateRunner } from "./updateRunner";
import { lifecycleDependencies } from "./lifecycleDependencies";

/**
 * 持有应用从取得单实例锁到释放锁的完整生命周期。所有会联网、创建 Worker、
 * 注册进程 handler 或写盘的动作都由显式 init/run/dispose 驱动，模块导入本身
 * 不启动任何组件。
 * @see ../../docs/architecture.md
 */
export class ApplicationLifecycle {
  constructor(private readonly dependencies: ApplicationLifecycleDependencies = lifecycleDependencies) {}

  private lockAcquired: boolean = false;
  private diskIOInitialized: boolean = false;
  private aiChatInitialized: boolean = false;
  private antiRaidInitialized: boolean = false;
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

  private readonly stopOnSignal = (): void => {
    this.stopRequested = true;
    this.quiesceMaintenance();
    this.runner?.stop().catch((error: unknown) => {
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
    this.runner?.stop().catch((stopError: unknown) => {
      this.dependencies.logger.error("Error stopping runner after persistence failure:", stopError);
    });
  };

  /** 初始化各组件并开始长轮询；重复调用会被拒绝。 */
  async init(): Promise<void> {
    if (this.runner !== null || this.lockAcquired) throw new Error("Application lifecycle is already initialized");

    await this.dependencies.acquireSingleInstanceLock(this.dependencies.BOT_TOKEN);
    this.lockAcquired = true;
    this.dependencies.setStatePersistenceFatalHandler(this.handleDiskIOFatal);
    this.dependencies.initAvatarUpdates();
    this.dependencies.initReactionQueue();
    this.dependencies.initChatTitleRefresh();

    // 配置文件属于不可信部署输入：持锁后、启动 Worker/联网前统一校验，失败时
    // 由 finally 释放实例锁；各 Worker 在自己的 isolate 中复用同一解析器。
    this.dependencies.getStickerConfig();
    this.dependencies.getReactionConfig();
    this.dependencies.getMoodConfig();
    await this.dependencies.cleanupOrphanedTempFiles();
    await this.dependencies.loadState();

    // state 主副本已经严格校验并建立 LKG 后，才创建运行时 Worker 和会安装
    // 心跳 timer 的 Telegram transformer；恢复失败不会留下半初始化组件。
    this.dependencies.initTelegramClients();
    this.dependencies.initDiskIO({ onFatal: this.handleDiskIOFatal });
    this.diskIOInitialized = true;

    const loaded: LoadedData = await this.dependencies.loadPersistedData();
    const restoredCopiedUser: CachedUser | null = this.dependencies.getGlobalCopyState().copiedUser;
    if (restoredCopiedUser) this.dependencies.seedSenderCache(restoredCopiedUser);

    this.handlers = this.dependencies.registerHandlers(this.dependencies.bot);
    await this.dependencies.registerCommandMenu(this.dependencies.bot);
    await this.dependencies.bot.init();

    this.dependencies.initAiChat(this.dependencies.bot.botInfo);
    this.aiChatInitialized = true;
    this.dependencies.hydrateAiMemory(loaded.aiMemories);
    this.dependencies.hydrateStickerCatalog(loaded.stickerCatalogs);
    this.dependencies.restoreLuckState(loaded.luckReceiptSecret, loaded.luckDay);
    this.dependencies.hydratePendingVerifications(loaded.verifications);
    this.dependencies.initAntiRaid();
    this.antiRaidInitialized = true;

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
      .catch((error: unknown) => {
        this.dependencies.logger.error("Failed to complete chat title refresh:", error);
      })
      .finally(() => { this.chatTitleRefreshSettled = true; });
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
    this.quiesceMaintenance();
    const runnerDrained: boolean = await this.waitForRunnerDrain(runner);

    // 标题刷新可能触发 saveStateInBackground；必须先等它完成，再做最终 flush。
    const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(
      NORMAL_FLUSH_TIMEOUTS.maintenanceMs
    );
    const persistenceFlushed: boolean = await this.flushAllToDisk(NORMAL_FLUSH_TIMEOUTS);

    const lastSeenUpdateId: number = this.handlers?.getLastSeenUpdateId() ?? 0;
    if (runnerDrained && maintenanceSettled && persistenceFlushed && lastSeenUpdateId > 0) {
      try {
        await this.dependencies.bot.api.getUpdates({ offset: lastSeenUpdateId + 1, limit: 1, timeout: 0 });
      } catch (error: unknown) {
        this.dependencies.logger.error("Failed to confirm update offset on shutdown:", error);
      }
    }
  }

  /** 停止活动 runner，等待后台任务完成，排空持久化并释放单实例锁。 */
  dispose(timeouts: FlushTimeouts = NORMAL_FLUSH_TIMEOUTS): Promise<void> {
    this.disposePromise ??= (async (): Promise<void> => {
      this.quiesceMaintenance();
      if (this.runner !== null && !this.runnerTaskSettled) {
        await this.runner.stop().catch((error: unknown) => {
          this.dependencies.logger.error("Error stopping runner during disposal:", error);
        });
      }
      const runnerDrained: boolean = this.runner === null
        ? true
        : await this.waitForRunnerDrain(this.runner);
      const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(timeouts.maintenanceMs);
      const avatarResult: FlushResult = await this.dependencies.drainAvatarUpdates(timeouts.maintenanceMs);
      const reactionResult: FlushResult = await this.dependencies.drainReactionQueue(timeouts.maintenanceMs);
      const antiRaidResult: FlushResult = this.antiRaidInitialized
        ? await this.dependencies.drainAntiRaid(timeouts.maintenanceMs)
        : "flushed";
      let aiResult: FlushResult = "flushed";
      if (this.aiChatInitialized) {
        aiResult = await this.dependencies.flushAiMemory(timeouts.aiMemoryMs);
        await this.dependencies.terminateAiChat();
        this.aiChatInitialized = false;
      }
      let diskResult: FlushResult = "flushed";
      if (this.diskIOInitialized) {
        diskResult = await this.dependencies.flushDiskIO(timeouts.diskIOMs);
      }
      if (this.antiRaidInitialized) {
        await this.dependencies.terminateAntiRaid();
        this.antiRaidInitialized = false;
      }
      if (this.diskIOInitialized) {
        await this.dependencies.terminateDiskIO();
        this.diskIOInitialized = false;
      }
      const stateResult: FlushResult = this.lockAcquired
        ? await this.dependencies.flushStateToDisk(timeouts.stateMs, true)
        : "flushed";
      this.dependencies.setStatePersistenceFatalHandler(undefined);
      if (
        !runnerDrained ||
        avatarResult !== "flushed" ||
        reactionResult !== "flushed" ||
        antiRaidResult !== "flushed" ||
        aiResult !== "flushed" ||
        diskResult !== "flushed" ||
        stateResult !== "flushed"
      ) {
        process.exitCode = 1;
        this.dependencies.logger.error(
          `Shutdown drain/flush results: runner=${runnerDrained}, avatar=${avatarResult}, reaction=${reactionResult}, ` +
          `antiRaid=${antiRaidResult}, ai=${aiResult}, disk=${diskResult}, state=${stateResult}.`
        );
      }
      if (!this.lockAcquired) return;
      if (
        !runnerDrained ||
        !maintenanceSettled ||
        avatarResult !== "flushed" ||
        reactionResult !== "flushed" ||
        antiRaidResult !== "flushed" ||
        aiResult !== "flushed" ||
        diskResult !== "flushed" ||
        stateResult !== "flushed"
      ) {
        this.dependencies.logger.error(
          "Retaining the single-instance lock until process exit because a task did not drain or persistence did not flush."
        );
        return;
      }
      await this.dependencies.releaseSingleInstanceLock(this.dependencies.BOT_TOKEN);
      this.lockAcquired = false;
    })();
    return this.disposePromise;
  }

  /** 生产运行入口：显式安装进程 handler，执行 init/wait，并保证 dispose。 */
  run(): Promise<void> {
    this.installProcessHandlers();
    return this.runMain()
      .catch((error: unknown) => {
        this.dependencies.logger.error("Unhandled error in bot main runner:", error);
        process.exitCode = 1;
      })
      .finally(async (): Promise<void> => {
        await this.dispose();
        this.removeProcessHandlers();
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
    void this.dispose(EMERGENCY_FLUSH_TIMEOUTS).finally(() => process.exit(1));
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
      this.dependencies.logger.error(
        `Shutdown proceeding with ${runner.size()} update(s) still being processed after waiting ${timeoutMs}ms; ` +
        "their Telegram offset will not be confirmed."
      );
      return false;
    }
    return true;
  }

  private async waitForBackgroundMaintenance(timeoutMs: number): Promise<boolean> {
    const task: Promise<void> | null = this.chatTitleRefreshTask;
    if (task === null || this.chatTitleRefreshSettled) return true;
    if (timeoutMs <= 0) {
      this.dependencies.logger.error("Skipping unfinished chat title refresh during emergency disposal.");
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled: boolean = await Promise.race([
      task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!settled) {
      this.dependencies.abortChatTitleRefresh();
      this.dependencies.logger.error(`Chat title refresh did not settle within ${timeoutMs}ms and was aborted.`);
    }
    return settled;
  }

  private quiesceMaintenance(): void {
    if (this.maintenanceQuiesced) return;
    this.maintenanceQuiesced = true;
    this.dependencies.quiesceAvatarUpdates();
    this.dependencies.quiesceReactionQueue();
    this.dependencies.quiesceChatTitleRefresh();
  }

  private async flushAllToDisk(timeouts: FlushTimeouts): Promise<boolean> {
    if (!this.lockAcquired) return false;
    // Worker mailbox 与主线程后台队列必须先归零；随后 flush 才覆盖它们发布的
    // 最后一份镜像，不能在 flush 后再让旧任务补写。
    const avatarResult: FlushResult = await this.dependencies.drainAvatarUpdates(timeouts.maintenanceMs);
    const reactionResult: FlushResult = await this.dependencies.drainReactionQueue(timeouts.maintenanceMs);
    const antiRaidResult: FlushResult = this.antiRaidInitialized
      ? await this.dependencies.drainAntiRaid(timeouts.maintenanceMs)
      : "flushed";
    // AI memory 必须先回传到 diskIOWorker，再 flush 该 Worker。
    const aiResult: FlushResult = this.aiChatInitialized
      ? await this.dependencies.flushAiMemory(timeouts.aiMemoryMs)
      : "flushed";
    const diskResult: FlushResult = this.diskIOInitialized
      ? await this.dependencies.flushDiskIO(timeouts.diskIOMs)
      : "flushed";
    const stateResult: FlushResult = await this.dependencies.flushStateToDisk(timeouts.stateMs);
    if (
      avatarResult !== "flushed" ||
      reactionResult !== "flushed" ||
      antiRaidResult !== "flushed" ||
      aiResult !== "flushed" ||
      diskResult !== "flushed" ||
      stateResult !== "flushed"
    ) {
      process.exitCode = 1;
      this.dependencies.logger.error(
        `Pre-confirmation drain/flush results: avatar=${avatarResult}, reaction=${reactionResult}, antiRaid=${antiRaidResult}, ` +
        `ai=${aiResult}, disk=${diskResult}, state=${stateResult}; ` +
        "the final Telegram update offset will not be confirmed."
      );
      return false;
    }
    return true;
  }
}

export function createApplicationLifecycle(): ApplicationLifecycle {
  return new ApplicationLifecycle();
}
