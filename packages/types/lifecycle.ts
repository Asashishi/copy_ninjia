import type { Update } from "grammy/types";

/** 单条确认 runner 订阅的 Telegram 更新类型；调用方只读共享列表。 */
export type TelegramAllowedUpdates = readonly Exclude<keyof Update, "update_id">[];

/** 生命周期排空阶段的统一结果。 */
export type FlushResult = "flushed" | "timedOut" | "failed";

/** 应用生命周期由测试/嵌入式宿主还是生产进程驱动。 */
export type ApplicationRunMode = "test" | "main";

/** 正常或异常停机时各持久化 owner 的完整时间预算。 */
export interface FlushTimeouts {
  aiMemoryMs: number;
  diskIOMs: number;
  stateMs: number;
  maintenanceMs: number;
}

/** grammY handler 安装后供生命周期读取的最终 update 边界。 */
export interface HandlerRegistration {
  getLastSeenUpdateId(): number;
}

/** acknowledgement-safe Telegram update runner 的生命周期控制面。 */
export interface AcknowledgedUpdateRunner {
  /** 停止继续取数；已开始的 middleware 留给生命周期按 size() 做有界排空。 */
  stop(): Promise<void>;
  /** 取数循环结束（不代表已开始的 middleware 全部结束）。 */
  task(): Promise<void>;
  /** 当前仍在执行的 middleware 数。 */
  size(): number;
  /**
   * 是否有 update 以抛错结束。为真时**不得**确认最终 Telegram offset：那条
   * update 必须留给 Telegram 在重启后重投。
   *
   * 单独暴露这个标记是因为停机路径会放弃在途 update、不再用它的结算结果决定
   * 退出状态；正常路径则由 task() 的 rejection 表达失败。标记在
   * handleUpdate 抛错的同一个同步段里写下，因此 size() 归零时它必然已生效。
   */
  hasFailedUpdate(): boolean;
  /** 中止全部活跃 update，并返回这次实际发出取消信号的数量。 */
  abortActive(): number;
}

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
  /**
   * 已处理 update 的最终确认边界是否安全完成；没有待确认 update 时同样为 true。
   * wait() 一旦确认失败或因关键 gate 未完成而跳过，就保持 false 到进程退出。
   */
  offsetConfirmed: boolean;
  avatar: FlushResult;
  translate: FlushResult;
  gag: FlushResult;
  antiRaid: FlushResult;
  ai: FlushResult;
  telegram: FlushResult;
  disk: FlushResult;
  terminate: FlushResult;
  state: FlushResult;
}

/**
 * 一次停机的结局分档。判定见 `packages/app/lifecycle/shutdown.ts` 的
 * `classifyShutdown`。
 *
 * 必须是三态而不是「干净 / 不干净」两态：`offsetWithheld` 指「所有 owner 都排空
 * 落盘、Worker 已终止，只有最终 offset 那道 gate 没走完」。它与 `unsettled` 同样
 * 非零退出并打印诊断行（offset 没确认意味着重启后会重投，运维必须看得见），但
 * **只有 `unsettled` 才扣住实例锁**——扣锁的唯一理由是「可能还有人在写共享数据
 * 目录」，而这一态下那个风险不存在。
 */
export type ShutdownOutcome = "clean" | "offsetWithheld" | "unsettled";

/** owner 结果部分（不含 runner、维护与 offset 门禁，它们由主文件在调用前算出）。 */
export type OwnerShutdownResults = Omit<
  ShutdownResults,
  "runnerDrained" | "maintenanceSettled" | "offsetConfirmed"
>;

/** 把单个 owner 的异常折算成兜底值并记录，绝不让它中断整段停机。 */
export interface OwnerSettler {
  /** 返回 FlushResult 的 owner；抛错记为 `"failed"`。 */
  flush(owner: string, run: () => Promise<FlushResult>): Promise<FlushResult>;
  /** 返回布尔门控的步骤（runner 排空、后台维护）；抛错记为 `false`。 */
  gate(owner: string, run: () => Promise<boolean>): Promise<boolean>;
  /** 返回 void 的终止型 owner；成功记为 `"flushed"`，抛错记为 `"failed"`。 */
  terminate(owner: string, run: () => Promise<void>): Promise<FlushResult>;
}
