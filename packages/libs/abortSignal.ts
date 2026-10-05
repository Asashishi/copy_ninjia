/**
 * AbortSignal 的组合工具。
 *
 * 与 libs/withTimeout.ts 分开：那边是给一个**已经在途、无法取消**的 Promise 加
 * 等待上限（超时只结束等待，底层任务照跑）；这边产出的是一个真能把下游 fetch
 * 掐断的 signal。两者名字相近但职责不同，不要合并。
 */

import { toErrorOr } from "./errorMessage";

/**
 * 把调用方的 invalidate signal 与一份**独立**的超时预算合成一个 signal。
 *
 * 每次调用现取一个 `AbortSignal.timeout`，因此同一次下载里的两步不会共享同一个
 * deadline——传入一个共享 signal 的话，第一步用掉的时间会从第二步的预算里扣。
 *
 * @param signal 调用方的取消源；缺省表示只受超时约束。
 * @param timeoutMs 本次调用独占的超时预算。
 */
export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 判定一个 signal 的中止是否来自**本次调用的超时预算**耗尽。
 *
 * 用来把「预算用完」与「群 teardown、停机取消」分开：前者是普通业务失败，调用方
 * 可以照常给用户回执；后者必须静默收场。判据是 `AbortSignal.timeout` 的取消原因为
 * name 是 `"TimeoutError"` 的 `DOMException`，而 `AbortController.abort()` 无参时给
 * 的是 `AbortError`。`AbortSignal.any` 原样透传首个触发源的 reason，signalWithTimeout
 * 合成出来的信号因此同样可判；未中止的 signal 一律为 false。
 */
export function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason as unknown;
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

/**
 * 判定一次失败是否就是取消本身：name 为 `"AbortError"` 的 `DOMException`。
 *
 * 覆盖 Worker 停机 drain 时 libs/workerDuplex.ts 本地结算的等待者、出站总闸撤销的
 * 排队请求等不经调用方 signal 的取消；超时给的是 `TimeoutError`，不在此列。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 取消原因必须以 Error 传播；标准 AbortController 的 DOMException 原样保留。 */
function abortSignalError(signal: AbortSignal): Error {
  return toErrorOr(signal.reason as unknown, "AbortSignal was aborted with a non-Error reason.");
}

/** Promise 违反 Error rejection 约定时在本边界归一化，原值保留为 cause。 */
function taskRejectionError(reason: unknown): Error {
  return toErrorOr(reason, "Abortable task rejected with a non-Error value.");
}

/**
 * 让独占下游任务的等待在 signal 中止时立即 reject。
 *
 * 调用方仍须把同一个 signal 交给下游，让网络请求和后续尝试真正停止；本函数负责
 * 收紧调用方可见的结算时机，即使下游库的内部退避等待不监听 signal，也不会把
 * 已取消的上层任务继续挂到退避结束。底层 Promise 的最终 rejection 始终有监听，
 * 不会在调用方提前离场后变成未处理 rejection。
 *
 * @param promise 独占于本次调用、不会被其他等待者复用的下游任务。
 * @param signal 本次调用的取消源；缺省时原样返回 promise，不额外分配包装 Promise。
 */
export function raceAbortOrThrow<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) return promise;
  const activeSignal: AbortSignal = signal;
  if (activeSignal.aborted) {
    // 下游任务在调用本函数前已经创建；即使 signal 预先中止，也必须接住它稍后的
    // rejection，避免 SDK 在检查已中止 signal 后产生未处理 rejection。
    void promise.catch((_error: unknown): void => undefined);
    return Promise.reject<T>(abortSignalError(activeSignal));
  }
  return new Promise<T>((
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    let finished: boolean = false;

    function claimSettlement(): boolean {
      if (finished) return false;
      finished = true;
      activeSignal.removeEventListener("abort", onAbort);
      return true;
    }

    function onAbort(): void {
      if (claimSettlement()) reject(abortSignalError(activeSignal));
    }

    activeSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value: T): void => {
        if (claimSettlement()) resolve(value);
      },
      (error: unknown): void => {
        if (claimSettlement()) reject(taskRejectionError(error));
      }
    );
  });
}

/** raceAbort 的取消源与回退值。同一份共享工作的各个等待者回退值不同，故按调用点传入。 */
export interface RaceAbortOptions<T> {
  /** 本等待者自己的取消源；缺省表示一直等到 promise 结算（此时原样返回 promise）。 */
  readonly signal?: AbortSignal;
  /** 因取消提前离场时交给本等待者的值。 */
  readonly cancelled: T;
  /**
   * promise 自身 reject 时交给本等待者的值。刻意不设默认值：T 常常把 null 或空表
   * 当成有意义的取值，一旦按「缺省沿用 cancelled」处理，调用方想把 reject 归到
   * null 上就无从表达，而且沉默地取错值。两者相同就显式写两遍。
   */
  readonly rejected: T;
}

/**
 * 让一份**共享**在途工作的等待服从各等待者自己的取消。
 *
 * 贴纸集合与贴纸菜单的请求合并、回复轮对媒体解析与机器人图片回填的等待，以及串行
 * 动作链对前一步的等待都走这里：任一调用方失效时只结束**它自己的等待**并拿到既定
 * 回退值，底层工作是否随之中止由其自身的取消信号决定。
 *
 * 与 libs/withTimeout.ts 的区别同本文件模块头：那边加的是等待上限，这边等的是别人
 * 的取消信号。
 */
export function raceAbort<T>(promise: Promise<T>, options: RaceAbortOptions<T>): Promise<T> {
  const signal: AbortSignal | undefined = options.signal;
  if (signal === undefined) return promise;
  const cancelled: T = options.cancelled;
  if (signal.aborted) {
    void promise.catch((_error: unknown): void => undefined);
    return Promise.resolve(cancelled);
  }
  const rejected: T = options.rejected;
  // 提升到函数声明之外：函数声明会被提升，TS 无法把上面的 undefined 收窄带进闭包。
  const activeSignal: AbortSignal = signal;
  return new Promise<T>((resolve: (value: T | PromiseLike<T>) => void): void => {
    let finished: boolean = false;

    function finish(result: T): void {
      if (finished) return;
      finished = true;
      activeSignal.removeEventListener("abort", onAbort);
      resolve(result);
    }

    function onAbort(): void {
      finish(cancelled);
    }

    // 已 abort 的 signal 不会再派发 abort 事件，但上面已经提前返回，因此这里
    // 注册即生效，无需在注册后再补一次 aborted 复查（复查在同步段内恒为 false）。
    activeSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(finish, (): void => finish(rejected));
  });
}
