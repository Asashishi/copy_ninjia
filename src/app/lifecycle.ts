import { flushAiMemory, hydrateAiMemory, hydrateStickerCatalog, initAiChat, terminateAiChat } from "../aiChat";
import { hydratePendingVerifications, initAntiRaid, terminateAntiRaid } from "../antiRaid";
import { restoreLuckState } from "../commands";
import { getReactionConfig } from "../config/reactions";
import { getStickerConfig } from "../config/stickers";
import {
  AI_MEMORY_FLUSH_TIMEOUT_MS,
  BACKGROUND_MAINTENANCE_TIMEOUT_MS,
  DISK_IO_FLUSH_TIMEOUT_MS,
  EMERGENCY_FLUSH_TIMEOUT_MS,
  RUNNER_DRAIN_POLL_INTERVAL_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
  STATE_FLUSH_TIMEOUT_MS,
  type FlushResult,
} from "../consts/lifecycle";
import { refreshAllChatTitles } from "../infra/chatTitle";
import { BOT_TOKEN } from "../infra/config";
import { flushDiskIO, initDiskIO, loadPersistedData, terminateDiskIO, type LoadedData } from "../infra/diskIO";
import { logger } from "../infra/logger";
import { cleanupOrphanedTempFiles } from "../infra/storage/cleanup";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../infra/storage/instanceLock";
import { flushStateToDisk, getAllChatStates, getGlobalCopyState, loadState } from "../infra/storage/stateStore";
import { bot, initTelegramClients } from "../infra/telegram";
import { sleep } from "../libs/sleep";
import type { CachedUser } from "../types/chatState";
import { seedSenderCache } from "../users/senderIdentity";
import { registerCommandMenu } from "./commandMenu";
import { registerHandlers, type HandlerRegistration } from "./registerHandlers";
import { runAcknowledgedUpdateBatches, type AcknowledgedUpdateRunner } from "./updateRunner";

const ALLOWED_UPDATES = [
  "message",
  "channel_post",
  "message_reaction",
  "chat_member",
  "my_chat_member",
  "callback_query",
  "inline_query",
  "chosen_inline_result",
] as const;

interface FlushTimeouts {
  aiMemoryMs: number;
  diskIOMs: number;
  stateMs: number;
  maintenanceMs: number;
}

const NORMAL_FLUSH_TIMEOUTS: FlushTimeouts = {
  aiMemoryMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
  diskIOMs: DISK_IO_FLUSH_TIMEOUT_MS,
  stateMs: STATE_FLUSH_TIMEOUT_MS,
  maintenanceMs: BACKGROUND_MAINTENANCE_TIMEOUT_MS,
};

const EMERGENCY_FLUSH_TIMEOUTS: FlushTimeouts = {
  aiMemoryMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  diskIOMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  stateMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  maintenanceMs: 0,
};

/**
 * 持有应用从取得单实例锁到释放锁的完整生命周期。所有会联网、创建 Worker、
 * 注册进程 handler 或写盘的动作都由显式 init/run/dispose 驱动，模块导入本身
 * 不启动任何组件。
 * @see ../../docs/architecture.md
 */
export class ApplicationLifecycle {
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

  private readonly stopOnSignal = (): void => {
    this.stopRequested = true;
    this.runner?.stop().catch((error: unknown) => {
      logger.error("Error stopping runner:", error);
    });
  };

  private readonly handleUncaughtException = (error: unknown): void => {
    logger.error("Uncaught exception, attempting a best-effort flush before exit:", error);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleUnhandledRejection = (reason: unknown): void => {
    logger.error("Unhandled rejection, attempting a best-effort flush before exit:", reason);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleDiskIOFatal = (error: Error): void => {
    logger.error("Persistence became unavailable at runtime; stopping for a supervised restart:", error);
    process.exitCode = 1;
    this.stopRequested = true;
    this.runner?.stop().catch((stopError: unknown) => {
      logger.error("Error stopping runner after persistence failure:", stopError);
    });
  };

  /** 初始化各组件并开始长轮询；重复调用会被拒绝。 */
  async init(): Promise<void> {
    if (this.runner !== null || this.lockAcquired) throw new Error("Application lifecycle is already initialized");

    await acquireSingleInstanceLock(BOT_TOKEN);
    this.lockAcquired = true;

    // 配置文件属于不可信部署输入：持锁后、启动 Worker/联网前统一校验，失败时
    // 由 finally 释放实例锁；各 Worker 在自己的 isolate 中复用同一解析器。
    getStickerConfig();
    getReactionConfig();
    initTelegramClients();
    initDiskIO({ onFatal: this.handleDiskIOFatal });
    this.diskIOInitialized = true;
    await cleanupOrphanedTempFiles();
    await loadState();

    // 这是后台维护任务而非启动阻塞项，但必须被追踪：退出最终快照前会等待它，
    // 防止 refresh 在 state.json flush 后才补写群名。
    this.chatTitleRefreshSettled = false;
    this.chatTitleRefreshTask = refreshAllChatTitles()
      .catch((error: unknown) => {
        logger.error("Failed to complete chat title refresh:", error);
      })
      .finally(() => { this.chatTitleRefreshSettled = true; });

    const loaded: LoadedData = await loadPersistedData();
    const restoredCopiedUser: CachedUser | null = getGlobalCopyState().copiedUser;
    if (restoredCopiedUser) seedSenderCache(restoredCopiedUser);

    this.handlers = registerHandlers(bot);
    await registerCommandMenu(bot);
    await bot.init();

    initAiChat(bot.botInfo);
    this.aiChatInitialized = true;
    hydrateAiMemory(loaded.aiMemories);
    hydrateStickerCatalog(loaded.stickerCatalogs);
    restoreLuckState(loaded.luckReceiptSecret, loaded.luckDay);
    hydratePendingVerifications(loaded.verifications);
    initAntiRaid();
    this.antiRaidInitialized = true;

    logger.log(
      `Bot started as @${bot.botInfo.username}. ` +
      `Restored state for ${getAllChatStates().size} chat(s)` +
      (restoredCopiedUser ? `, currently copying ${restoredCopiedUser.id}.` : ".")
    );

    this.runner = runAcknowledgedUpdateBatches(bot, ALLOWED_UPDATES);
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
    const runnerDrained: boolean = await this.waitForRunnerDrain(runner);

    // 标题刷新可能触发 saveStateInBackground；必须先等它完成，再做最终 flush。
    const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(
      NORMAL_FLUSH_TIMEOUTS.maintenanceMs
    );
    const persistenceFlushed: boolean = await this.flushAllToDisk(NORMAL_FLUSH_TIMEOUTS);

    const lastSeenUpdateId: number = this.handlers?.getLastSeenUpdateId() ?? 0;
    if (runnerDrained && maintenanceSettled && persistenceFlushed && lastSeenUpdateId > 0) {
      try {
        await bot.api.getUpdates({ offset: lastSeenUpdateId + 1, limit: 1, timeout: 0 });
      } catch (error: unknown) {
        logger.error("Failed to confirm update offset on shutdown:", error);
      }
    }
  }

  /** 停止活动 runner，等待后台任务完成，排空持久化并释放单实例锁。 */
  dispose(timeouts: FlushTimeouts = NORMAL_FLUSH_TIMEOUTS): Promise<void> {
    this.disposePromise ??= (async (): Promise<void> => {
      if (this.runner !== null && !this.runnerTaskSettled) {
        await this.runner.stop().catch((error: unknown) => {
          logger.error("Error stopping runner during disposal:", error);
        });
      }
      const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(timeouts.maintenanceMs);
      let aiResult: FlushResult = "flushed";
      if (this.aiChatInitialized) {
        aiResult = await flushAiMemory(timeouts.aiMemoryMs);
        await terminateAiChat();
        this.aiChatInitialized = false;
      }
      if (this.antiRaidInitialized) {
        await terminateAntiRaid();
        this.antiRaidInitialized = false;
      }
      let diskResult: FlushResult = "flushed";
      if (this.diskIOInitialized) {
        diskResult = await flushDiskIO(timeouts.diskIOMs);
        await terminateDiskIO();
        this.diskIOInitialized = false;
      }
      const stateResult: FlushResult = this.lockAcquired
        ? await flushStateToDisk(timeouts.stateMs, true)
        : "flushed";
      if (aiResult !== "flushed" || diskResult !== "flushed" || stateResult !== "flushed") {
        logger.error(
          `Shutdown flush results: ai=${aiResult}, disk=${diskResult}, state=${stateResult}.`
        );
      }
      if (!this.lockAcquired) return;
      if (!maintenanceSettled || stateResult !== "flushed") {
        logger.error(
          "Retaining the single-instance lock until process exit because a maintenance task or state writer may still mutate shared files."
        );
        return;
      }
      await releaseSingleInstanceLock(BOT_TOKEN);
      this.lockAcquired = false;
    })();
    return this.disposePromise;
  }

  /** 生产运行入口：显式安装进程 handler，执行 init/wait，并保证 dispose。 */
  run(): Promise<void> {
    this.installProcessHandlers();
    return this.runMain()
      .catch((error: unknown) => {
        logger.error("Unhandled error in bot main runner:", error);
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
      await sleep(RUNNER_DRAIN_POLL_INTERVAL_MS);
    }
    if (runner.size() > 0) {
      logger.error(
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
      logger.error("Skipping unfinished chat title refresh during emergency disposal.");
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
    if (!settled) logger.error(`Chat title refresh did not settle within ${timeoutMs}ms.`);
    return settled;
  }

  private async flushAllToDisk(timeouts: FlushTimeouts): Promise<boolean> {
    if (!this.lockAcquired) return false;
    // AI memory 必须先回传到 diskIOWorker，再 flush 该 Worker。
    const aiResult: FlushResult = this.aiChatInitialized
      ? await flushAiMemory(timeouts.aiMemoryMs)
      : "flushed";
    const diskResult: FlushResult = this.diskIOInitialized
      ? await flushDiskIO(timeouts.diskIOMs)
      : "flushed";
    const stateResult: FlushResult = await flushStateToDisk(timeouts.stateMs);
    if (aiResult !== "flushed" || diskResult !== "flushed" || stateResult !== "flushed") {
      logger.error(
        `Pre-confirmation flush results: ai=${aiResult}, disk=${diskResult}, state=${stateResult}; ` +
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
