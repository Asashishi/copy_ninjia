/**
 * AbortSignal 的组合工具。
 *
 * 与 libs/withTimeout.ts 分开：那边是给一个**已经在途、无法取消**的 Promise 加
 * 等待上限（超时只结束等待，底层任务照跑）；这边产出的是一个真能把下游 fetch
 * 掐断的 signal。两者名字相近但职责不同，不要合并。
 */

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

/** raceAbort 的回退值与收尾钩子。同一份共享工作的各个等待者回退值不同，故按调用点传入。 */
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
  /** 本等待者离场时的收尾，取消与正常结算都走一次，如引用计数释放。 */
  readonly onSettle?: () => void;
  /** 仅因取消离场时在 onSettle 之后追加的收尾，如「最后一个消费者走了就中止底层任务」。 */
  readonly onCancel?: () => void;
}

/**
 * 让一份**共享**在途工作的等待服从各等待者自己的取消。
 *
 * 媒体描述、贴纸集合、贴纸菜单都做请求合并：一份在途工作被多个调用方复用，任一
 * 调用方失效时只应结束**它自己的等待**并拿到既定回退值，底层是否随之中止由调用点
 * 的引用计数或 Worker 信号决定（onCancel）。此前四处各写了一份同形的闩锁 + 监听器
 * 摘除，任何一处的疏漏都要修四遍，故收口到这里。
 *
 * 与 libs/withTimeout.ts 的区别同本文件模块头：那边加的是等待上限，这边等的是别人
 * 的取消信号。
 *
 * 取消时钩子顺序固定为 onSettle → onCancel：引用计数必须先释放，onCancel 才能读到
 * 「本等待者已离场」后的真实计数。
 */
export function raceAbort<T>(promise: Promise<T>, options: RaceAbortOptions<T>): Promise<T> {
  const signal: AbortSignal | undefined = options.signal;
  if (signal === undefined) return promise;
  const cancelled: T = options.cancelled;
  if (signal.aborted) {
    options.onSettle?.();
    options.onCancel?.();
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
      options.onSettle?.();
      resolve(result);
    }

    function onAbort(): void {
      finish(cancelled);
      options.onCancel?.();
    }

    // 已 abort 的 signal 不会再派发 abort 事件，但上面已经提前返回，因此这里
    // 注册即生效，无需在注册后再补一次 aborted 复查（复查在同步段内恒为 false）。
    activeSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(finish, (): void => finish(rejected));
  });
}
