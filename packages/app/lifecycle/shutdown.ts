import type { ApplicationLifecycleDependencies, FlushResult, FlushTimeouts } from "../../types/lifecycle";

/**
 * 停机时各持久化/后台 owner 的排空顺序与失败隔离（owner 是 packages/app/lifecycle.ts）。
 * 主文件保留 init/wait/run、进程 handler 与实例锁处置，这里只负责「按固定顺序
 * 走完每个 owner，并把每一步的结果如实带回去」。
 *
 * 失败隔离是本模块存在的理由：异常退出路径上 dispose() 是最后一次落盘机会，
 * 任何单个 owner 抛错都不允许跳过其后的 owner 与 flushStateToDisk。
 * @see ../../../docs/04-invariants.md
 */

/** 各 owner 是否已初始化；停机据此跳过未启动的步骤，并在终止后就地置回 false。 */
export interface OwnerInitFlags {
  aiChatInitialized: boolean;
  antiRaidInitialized: boolean;
  diskIOInitialized: boolean;
  translateInitialized: boolean;
}

/** 一次停机里各 owner 的结算结果，决定退出码与实例锁是否释放。 */
export interface ShutdownResults {
  runnerDrained: boolean;
  maintenanceSettled: boolean;
  avatar: FlushResult;
  reaction: FlushResult;
  translate: FlushResult;
  antiRaid: FlushResult;
  ai: FlushResult;
  disk: FlushResult;
  terminate: FlushResult;
  state: FlushResult;
}

/** owner 结果部分（不含 runner/维护两项，它们由主文件在调用前算出）。 */
export type OwnerShutdownResults = Omit<ShutdownResults, "runnerDrained" | "maintenanceSettled">;

/** 把单个 owner 的异常折算成兜底值并记录，绝不让它中断整段停机。 */
export interface OwnerSettler {
  /** 返回 FlushResult 的 owner；抛错记为 `"failed"`。 */
  flush(owner: string, run: () => Promise<FlushResult>): Promise<FlushResult>;
  /** 返回布尔门控的步骤（runner 排空、后台维护）；抛错记为 `false`。 */
  gate(owner: string, run: () => Promise<boolean>): Promise<boolean>;
  /** 返回 void 的终止型 owner；成功记为 `"flushed"`，抛错记为 `"failed"`。 */
  terminate(owner: string, run: () => Promise<void>): Promise<FlushResult>;
}

/** 绑定一份 logger，生成本次停机使用的失败隔离器。 */
export function createOwnerSettler(logger: ApplicationLifecycleDependencies["logger"]): OwnerSettler {
  async function settle<T>(owner: string, run: () => Promise<T>, onFailure: T): Promise<T> {
    try {
      return await run();
    } catch (error: unknown) {
      logger.error(`Shutdown owner ${owner} threw during disposal:`, error);
      return onFailure;
    }
  }
  return {
    flush: (owner: string, run: () => Promise<FlushResult>): Promise<FlushResult> => settle<FlushResult>(owner, run, "failed"),
    gate: (owner: string, run: () => Promise<boolean>): Promise<boolean> => settle<boolean>(owner, run, false),
    terminate: (owner: string, run: () => Promise<void>): Promise<FlushResult> => settle<FlushResult>(owner, async (): Promise<FlushResult> => {
      await run();
      return "flushed";
    }, "failed"),
  };
}

export interface RunShutdownOwnersParams {
  dependencies: ApplicationLifecycleDependencies;
  /** 就地更新：终止过的 owner 会被置回 false，防止重复终止。 */
  flags: OwnerInitFlags;
  settler: OwnerSettler;
  timeouts: FlushTimeouts;
  /** 未持锁时不写 state，避免与真正的持锁进程抢同一份文件。 */
  lockAcquired: boolean;
}

/**
 * 按「排空后台 owner → flush AI → 终止 AI → flush Disk I/O → 终止
 * Anti-Raid/Disk I/O → flush StateStore」的固定顺序收尾。
 * @returns 每个 owner 的结算结果；不抛错，异常一律折算进结果。
 */
export async function runShutdownOwners({
  dependencies,
  flags,
  settler,
  timeouts,
  lockAcquired,
}: RunShutdownOwnersParams): Promise<OwnerShutdownResults> {
  const avatar: FlushResult = await settler.flush(
    "avatar drain",
    (): Promise<FlushResult> => dependencies.drainAvatarUpdates(timeouts.maintenanceMs)
  );
  const reaction: FlushResult = await settler.flush(
    "reaction drain",
    (): Promise<FlushResult> => dependencies.drainReactionQueue(timeouts.maintenanceMs)
  );

  let translate: FlushResult = "flushed";
  if (flags.translateInitialized) {
    translate = await settler.flush("translate drain", (): Promise<FlushResult> => dependencies.drainTranslate(timeouts.maintenanceMs));
    const closed: FlushResult = await settler.flush(
      "translate close",
      (): Promise<FlushResult> => dependencies.closeTranslate(timeouts.maintenanceMs)
    );
    if (translate === "flushed" && closed !== "flushed") translate = closed;
    flags.translateInitialized = false;
  }

  const antiRaid: FlushResult = flags.antiRaidInitialized
    ? await settler.flush("anti-raid drain", (): Promise<FlushResult> => dependencies.drainAntiRaid(timeouts.maintenanceMs))
    : "flushed";

  // 终止型 owner 的失败单独汇总：它们排在各自 flush 之后，失败不影响已经
  // 落盘的数据，但仍要如实反映在退出码与实例锁处置上。
  let terminate: FlushResult = "flushed";
  const recordTermination = (result: FlushResult): void => {
    if (result !== "flushed") terminate = result;
  };

  let ai: FlushResult = "flushed";
  if (flags.aiChatInitialized) {
    ai = await settler.flush("AI memory flush", (): Promise<FlushResult> => dependencies.flushAiMemory(timeouts.aiMemoryMs));
    recordTermination(await settler.terminate("AI chat termination", (): Promise<void> => dependencies.terminateAiChat()));
    flags.aiChatInitialized = false;
  }

  const disk: FlushResult = flags.diskIOInitialized
    ? await settler.flush("disk I/O flush", (): Promise<FlushResult> => dependencies.flushDiskIO(timeouts.diskIOMs))
    : "flushed";

  if (flags.antiRaidInitialized) {
    recordTermination(await settler.terminate("anti-raid termination", (): Promise<void> => dependencies.terminateAntiRaid()));
    flags.antiRaidInitialized = false;
  }
  if (flags.diskIOInitialized) {
    recordTermination(await settler.terminate("disk I/O termination", (): Promise<void> => dependencies.terminateDiskIO()));
    flags.diskIOInitialized = false;
  }

  const state: FlushResult = lockAcquired
    ? await settler.flush("state flush", (): Promise<FlushResult> => dependencies.flushStateToDisk(timeouts.stateMs, true))
    : "flushed";

  return { avatar, reaction, translate, antiRaid, ai, disk, terminate, state };
}

/** 本次停机是否每个 owner 都干净收尾；任一项未 flushed 都要保留实例锁。 */
export function isCleanShutdown(results: ShutdownResults): boolean {
  return results.runnerDrained &&
    results.maintenanceSettled &&
    results.avatar === "flushed" &&
    results.reaction === "flushed" &&
    results.translate === "flushed" &&
    results.antiRaid === "flushed" &&
    results.ai === "flushed" &&
    results.disk === "flushed" &&
    results.terminate === "flushed" &&
    results.state === "flushed";
}

/** 停机结果的单行诊断文案（英文，见 AGENTS.md 日志约定）。 */
export function formatShutdownResults(results: ShutdownResults): string {
  return `runner=${results.runnerDrained}, maintenance=${results.maintenanceSettled}, ` +
    `avatar=${results.avatar}, reaction=${results.reaction}, translate=${results.translate}, ` +
    `antiRaid=${results.antiRaid}, ai=${results.ai}, disk=${results.disk}, ` +
    `terminate=${results.terminate}, state=${results.state}`;
}

export interface FlushAllToDiskParams {
  dependencies: ApplicationLifecycleDependencies;
  flags: OwnerInitFlags;
  settler: OwnerSettler;
  timeouts: FlushTimeouts;
}

/**
 * 确认最终 Telegram offset 之前的完整落盘：Worker mailbox 与主线程后台队列
 * 必须先归零，随后 flush 才覆盖它们发布的最后一份镜像，不能在 flush 后再让
 * 旧任务补写。与 runShutdownOwners 不同，这里不终止任何 Worker。
 * @returns 是否全部干净落盘；false 时调用方不得确认 offset。
 */
export async function flushAllToDisk({
  dependencies,
  flags,
  settler,
  timeouts,
}: FlushAllToDiskParams): Promise<boolean> {
  const avatar: FlushResult = await settler.flush(
    "avatar drain",
    (): Promise<FlushResult> => dependencies.drainAvatarUpdates(timeouts.maintenanceMs)
  );
  const reaction: FlushResult = await settler.flush(
    "reaction drain",
    (): Promise<FlushResult> => dependencies.drainReactionQueue(timeouts.maintenanceMs)
  );
  const translate: FlushResult = flags.translateInitialized
    ? await settler.flush("translate drain", (): Promise<FlushResult> => dependencies.drainTranslate(timeouts.maintenanceMs))
    : "flushed";
  const antiRaid: FlushResult = flags.antiRaidInitialized
    ? await settler.flush("anti-raid drain", (): Promise<FlushResult> => dependencies.drainAntiRaid(timeouts.maintenanceMs))
    : "flushed";
  // AI memory 必须先回传到 diskIOWorker，再 flush 该 Worker。
  const ai: FlushResult = flags.aiChatInitialized
    ? await settler.flush("AI memory flush", (): Promise<FlushResult> => dependencies.flushAiMemory(timeouts.aiMemoryMs))
    : "flushed";
  const disk: FlushResult = flags.diskIOInitialized
    ? await settler.flush("disk I/O flush", (): Promise<FlushResult> => dependencies.flushDiskIO(timeouts.diskIOMs))
    : "flushed";
  const state: FlushResult = await settler.flush(
    "state flush",
    (): Promise<FlushResult> => dependencies.flushStateToDisk(timeouts.stateMs)
  );

  if (
    avatar !== "flushed" ||
    reaction !== "flushed" ||
    translate !== "flushed" ||
    antiRaid !== "flushed" ||
    ai !== "flushed" ||
    disk !== "flushed" ||
    state !== "flushed"
  ) {
    process.exitCode = 1;
    dependencies.logger.error(
      `Pre-confirmation drain/flush results: avatar=${avatar}, reaction=${reaction}, antiRaid=${antiRaid}, ` +
      `translate=${translate}, ai=${ai}, disk=${disk}, state=${state}; ` +
      "the final Telegram update offset will not be confirmed."
    );
    return false;
  }
  return true;
}
