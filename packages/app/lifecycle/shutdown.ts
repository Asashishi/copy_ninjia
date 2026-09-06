import type {
  FlushResult,
  FlushTimeouts,
  OwnerInitFlags,
  OwnerSettler,
  OwnerShutdownResults,
  ShutdownOutcome,
  ShutdownResults,
} from "../../types/lifecycle";
import type { ApplicationLifecycleDependencies } from "../lifecycleDependencies";

/**
 * 停机时各持久化/后台 owner 的排空顺序与失败隔离（owner 是 packages/app/lifecycle.ts）。
 * 主文件保留 init/wait/run、进程 handler 与实例锁处置，这里只负责「按固定顺序
 * 走完每个 owner，并把每一步的结果如实带回去」。
 *
 * 失败隔离是本模块存在的理由：异常退出路径上 dispose() 是最后一次落盘机会，
 * 任何单个 owner 抛错都不允许跳过其后的 owner 与 flushStateToDisk。
 * @see ../../../docs/cn/04-invariants.md
 */

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

/**
 * 排空阶段的结果字段；`terminate` 与 `state` 不在其中，它们由调用方按各自语义
 * 单独收束（终止只在 dispose() 发生，state flush 的持锁前提也只有 dispose() 有）。
 */
type OwnerDrainResults = Omit<OwnerShutdownResults, "terminate" | "state">;

/** 仅 dispose() 执行的、紧跟在某个 owner 排空之后的收尾步骤。 */
type ShutdownOwnerClose =
  | {
    /** 结果并进该 owner 自己的字段（排空成功但关闭失败，这个 owner 就不算干净）。 */
    readonly kind: "flush";
    readonly label: string;
    readonly run: (
      dependencies: ApplicationLifecycleDependencies,
      timeoutMs: number
    ) => Promise<FlushResult>;
  }
  | {
    /** 结果并进 terminate 汇总（失败不影响已落盘的数据，但要反映在退出码上）。 */
    readonly kind: "terminate";
    readonly label: string;
    readonly run: (dependencies: ApplicationLifecycleDependencies) => Promise<void>;
  };

/** 一个按固定顺序排空的停机 owner。 */
interface ShutdownDrainOwner {
  /** 写进哪个结果字段；延迟删除不参与共享数据落盘闸门，为 null。 */
  readonly result: keyof OwnerDrainResults | null;
  /** 失败隔离与诊断日志里的 owner 名。 */
  readonly label: string;
  /** 取哪一档时间预算。 */
  readonly timeout: keyof FlushTimeouts;
  /** 未初始化就整步跳过（记为 flushed）；终止后由 close 把它置回 false。 */
  readonly initFlag: keyof OwnerInitFlags | null;
  readonly drain: (
    dependencies: ApplicationLifecycleDependencies,
    timeoutMs: number,
    /** 本次是不是进程真正要退出的那一遍（dispose()）。 */
    terminal: boolean
  ) => Promise<FlushResult>;
  readonly close?: ShutdownOwnerClose;
}

/**
 * 停机 owner 的**唯一**有序表：确认最终 offset 之前的落盘（flushAllToDisk）与
 * 进程退出前的收尾（runShutdownOwners）共用它。
 *
 * 两个入口必须共用这一份顺序、门禁与结果聚合；否则任一 owner 未纳入确认前
 * flush，就可能在数据尚未落盘时推进最终 Telegram offset。
 *
 * 顺序本身是约束，不能随手调整（见 docs/cn/04-invariants.md）：
 * - wed、gag 与延迟删除必须排在 Telegram 总闸**之前**——它们的收尾都要发 Telegram
 *   请求，闸门一关就再也发不出去。
 * - 延迟删除排在 anti-raid 之后：广告处置会在 anti-raid 排空期间补发 30 秒公告，
 *   排在后面才能把最后一条也提前兑现。
 * - AI memory 必须先回传到 diskIOWorker，再 flush 那个 Worker。
 */
const SHUTDOWN_DRAIN_OWNERS: readonly Readonly<ShutdownDrainOwner>[] = [
  {
    result: "avatar",
    label: "avatar drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainAvatarUpdates(timeoutMs),
  },
  {
    result: "translate",
    label: "translate drain",
    timeout: "maintenanceMs",
    initFlag: "translateInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainTranslate(timeoutMs),
    close: {
      kind: "flush",
      label: "translate close",
      run: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
        dependencies.closeTranslate(timeoutMs),
    },
  },
  {
    result: "antiRaid",
    label: "anti-raid drain",
    timeout: "maintenanceMs",
    initFlag: "antiRaidInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainAntiRaid(timeoutMs),
  },
  {
    // gag 开始提示是带按钮的功能状态，必须在 Telegram 总闸关闭前由自己的状态机
    // 删除；失败不能伪装成总闸已经排空。
    result: "gag",
    label: "gag drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainGagRuntime(timeoutMs),
  },
  {
    result: "wed",
    label: "wed drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainWedRuntime(timeoutMs),
  },
  {
    // 删除失败/超时有自己的统一日志，但不属于共享数据落盘闸门。
    result: null,
    label: "Telegram delayed deletion drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainPendingMessageDeletions(timeoutMs),
  },
  {
    result: "ai",
    label: "AI memory flush",
    timeout: "aiMemoryMs",
    initFlag: "aiChatInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.flushAiMemory(timeoutMs),
    close: {
      kind: "terminate",
      label: "AI chat termination",
      run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateAiChat(),
    },
  },
  {
    result: "telegram",
    label: "Telegram outbound drain",
    timeout: "maintenanceMs",
    initFlag: null,
    // 关闸只在终局那一遍：offset 确认前那次若把闸门关掉，dispose() 里 gag、延迟
    // 删除与 anti-raid 的重试就只剩 AbortError（见 outboundGate 的 quiesce 说明）。
    drain: (
      dependencies: ApplicationLifecycleDependencies,
      timeoutMs: number,
      terminal: boolean
    ): Promise<FlushResult> => dependencies.drainTelegramOutbound(timeoutMs, { quiesce: terminal }),
  },
  {
    result: "disk",
    label: "disk I/O flush",
    timeout: "diskIOMs",
    initFlag: "diskIOInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.flushDiskIO(timeoutMs),
  },
];

/** 排空全部结束后才执行的终止型 owner，顺序同样固定；只有 dispose() 走。 */
const SHUTDOWN_TERMINATION_OWNERS: readonly Readonly<{
  readonly label: string;
  readonly initFlag: keyof OwnerInitFlags;
  readonly run: (dependencies: ApplicationLifecycleDependencies) => Promise<void>;
}>[] = [
  {
    label: "anti-raid termination",
    initFlag: "antiRaidInitialized",
    run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateAntiRaid(),
  },
  {
    label: "disk I/O termination",
    initFlag: "diskIOInitialized",
    run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateDiskIO(),
  },
];

interface DrainOwnersParams {
  dependencies: ApplicationLifecycleDependencies;
  flags: OwnerInitFlags;
  settler: OwnerSettler;
  timeouts: FlushTimeouts;
  /** true 表示进程要退出的那一遍：执行 close 步骤、关闭 Telegram 闸门、重置 flag。 */
  terminal: boolean;
}

/** 一次走完 SHUTDOWN_DRAIN_OWNERS，返回各 owner 结果与终止型步骤的汇总。 */
async function drainOwners({
  dependencies,
  flags,
  settler,
  timeouts,
  terminal,
}: DrainOwnersParams): Promise<{ results: OwnerDrainResults; terminate: FlushResult }> {
  const results: OwnerDrainResults = {
    avatar: "flushed",
    translate: "flushed",
    gag: "flushed",
    wed: "flushed",
    antiRaid: "flushed",
    ai: "flushed",
    telegram: "flushed",
    disk: "flushed",
  };
  let terminate: FlushResult = "flushed";

  for (const owner of SHUTDOWN_DRAIN_OWNERS) {
    if (owner.initFlag !== null && !flags[owner.initFlag]) continue;
    const timeoutMs: number = timeouts[owner.timeout];
    let result: FlushResult = await settler.flush(
      owner.label,
      (): Promise<FlushResult> => owner.drain(dependencies, timeoutMs, terminal)
    );
    // close 是终局专属：offset 确认前那一遍不关闭任何 owner，后面还要用它们。
    if (terminal && owner.close !== undefined) {
      if (owner.close.kind === "flush") {
        const closeStep: Extract<ShutdownOwnerClose, { kind: "flush" }> = owner.close;
        const closed: FlushResult = await settler.flush(
          closeStep.label,
          (): Promise<FlushResult> => closeStep.run(dependencies, timeoutMs)
        );
        if (result === "flushed" && closed !== "flushed") result = closed;
      } else {
        const closeStep: Extract<ShutdownOwnerClose, { kind: "terminate" }> = owner.close;
        const closed: FlushResult = await settler.terminate(
          closeStep.label,
          (): Promise<void> => closeStep.run(dependencies)
        );
        if (closed !== "flushed") terminate = closed;
      }
      if (owner.initFlag !== null) flags[owner.initFlag] = false;
    }
    if (owner.result !== null) results[owner.result] = result;
  }

  return { results, terminate };
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
 * 按 SHUTDOWN_DRAIN_OWNERS 的固定顺序收尾，再终止 Anti-Raid / Disk I/O，最后
 * flush StateStore。与 flushAllToDisk 的差别只有三处：执行 close 步骤、关闭
 * Telegram 出站闸门、写 state 前要求持锁。
 * @returns 每个 owner 的结算结果；不抛错，异常一律折算进结果。
 */
export async function runShutdownOwners({
  dependencies,
  flags,
  settler,
  timeouts,
  lockAcquired,
}: RunShutdownOwnersParams): Promise<OwnerShutdownResults> {
  const { results, terminate: closeTerminate }: {
    results: OwnerDrainResults;
    terminate: FlushResult;
  } = await drainOwners({ dependencies, flags, settler, timeouts, terminal: true });

  // 终止型 owner 的失败单独汇总：它们排在各自 flush 之后，失败不影响已经
  // 落盘的数据，但仍要如实反映在退出码与实例锁处置上。
  let terminate: FlushResult = closeTerminate;
  for (const owner of SHUTDOWN_TERMINATION_OWNERS) {
    if (!flags[owner.initFlag]) continue;
    const result: FlushResult = await settler.terminate(
      owner.label,
      (): Promise<void> => owner.run(dependencies)
    );
    if (result !== "flushed") terminate = result;
    flags[owner.initFlag] = false;
  }

  const state: FlushResult = lockAcquired
    ? await settler.flush("state flush", (): Promise<FlushResult> => dependencies.flushStateToDisk(timeouts.stateMs, true))
    : "flushed";

  return { ...results, terminate, state };
}

/**
 * 本次停机每个**会写共享数据的** owner 是否都干净收尾。
 *
 * 刻意不看 `offsetConfirmed`：那道 gate 只决定 Telegram 会不会重投，与「此刻
 * 还有没有人可能往数据目录里写」无关。两件事的处置也不同——见
 * classifyShutdown。
 */
function allOwnersSettled(results: ShutdownResults): boolean {
  return results.runnerDrained &&
    results.maintenanceSettled &&
    results.avatar === "flushed" &&
    results.translate === "flushed" &&
    results.gag === "flushed" &&
    results.wed === "flushed" &&
    results.antiRaid === "flushed" &&
    results.ai === "flushed" &&
    results.telegram === "flushed" &&
    results.disk === "flushed" &&
    results.terminate === "flushed" &&
    results.state === "flushed";
}

/**
 * 把停机结局分成三态（语义与取舍见 types/lifecycle.ts 的 `ShutdownOutcome`）。
 *
 * 中间那一态由三条路径产生：最终确认请求失败、前置未满足而跳过，或
 * `runner.task()` 直接抛错把整段确认前闸门跳过。
 *
 * 判据必须是**调用方自己这一轮**的 `ShutdownResults`，不是 `wait()` 当时的观测：
 * `wait()` 里 flush 失败、随后 `dispose()` 自己那次 flush 成功，正是「offset 该扣、
 * 锁该放」的正当组合。
 */
export function classifyShutdown(results: ShutdownResults): ShutdownOutcome {
  if (!allOwnersSettled(results)) return "unsettled";
  return results.offsetConfirmed ? "clean" : "offsetWithheld";
}

/** 停机结果的单行诊断文案（英文，见 AGENTS.md 日志约定）。 */
export function formatShutdownResults(results: ShutdownResults): string {
  return `runner=${results.runnerDrained}, maintenance=${results.maintenanceSettled}, ` +
    `offset=${results.offsetConfirmed}, ` +
    `avatar=${results.avatar}, translate=${results.translate}, gag=${results.gag}, wed=${results.wed}, ` +
    `antiRaid=${results.antiRaid}, ai=${results.ai}, telegram=${results.telegram}, disk=${results.disk}, ` +
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
 * 旧任务补写。owner 顺序与 runShutdownOwners 共用 SHUTDOWN_DRAIN_OWNERS，
 * 差别只在这里**不终止任何 Worker、也不关闭 Telegram 出站闸门**——dispose()
 * 还要再排空一遍 gag 提示与延迟删除，而那些收尾都要发 Telegram 请求。
 * @returns 是否全部干净落盘；false 时调用方不得确认 offset。
 */
export async function flushAllToDisk({
  dependencies,
  flags,
  settler,
  timeouts,
}: FlushAllToDiskParams): Promise<boolean> {
  const { results }: { results: OwnerDrainResults } = await drainOwners({
    dependencies,
    flags,
    settler,
    timeouts,
    terminal: false,
  });
  const state: FlushResult = await settler.flush(
    "state flush",
    (): Promise<FlushResult> => dependencies.flushStateToDisk(timeouts.stateMs)
  );

  const unsettled: boolean = state !== "flushed" ||
    Object.values(results).some((result: FlushResult): boolean => result !== "flushed");
  if (unsettled) {
    process.exitCode = 1;
    dependencies.logger.error(
      `Pre-confirmation drain/flush results: avatar=${results.avatar}, antiRaid=${results.antiRaid}, ` +
      `translate=${results.translate}, gag=${results.gag}, wed=${results.wed}, ai=${results.ai}, ` +
      `telegram=${results.telegram}, disk=${results.disk}, state=${state}; ` +
      "the final Telegram update offset will not be confirmed."
    );
    return false;
  }
  return true;
}
