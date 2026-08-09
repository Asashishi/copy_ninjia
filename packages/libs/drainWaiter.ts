import type { FlushResult } from "../types/lifecycle";

/**
 * 停机 drain 的公共骨架：等待某个 owner 的在途与待执行工作归零，超出预算则
 * abort 并结算。头像与反应两个队列除 abort/空闲判定不同外完全同构，语义（尤
 * 其是「预算为 0 时立即 abort 并结算」）只在这里实现一次。
 * @see ../../docs/cn/04-invariants.md
 */
export interface DrainWaiterParams {
  /** owner 名，用于参数校验的错误文案（英文，见 AGENTS.md 日志约定）。 */
  owner: string;
  /** 本次 drain 的预算；0 表示没有等待窗口，负数与非有限值一律拒绝。 */
  timeoutMs: number;
  /** owner 当前是否已无在途任务与待执行任务。 */
  isIdle: () => boolean;
  /** owner 持有的空闲回调集合；本函数只负责登记与摘除自己那一个。 */
  waiters: Set<() => void>;
  /** 触发一次空闲检查，覆盖「登记 waiter」与「owner 恰好转为空闲」之间的缝隙。 */
  notifyIfIdle: () => void;
  /** 预算耗尽时打断在途请求、结算尚未开始的任务。 */
  abort: () => void;
}

/**
 * 有界等待某个 owner 排空。
 * @returns 归零返回 `"flushed"`；预算耗尽时先 abort 再返回 `"timedOut"`。
 */
export function drainWithWaiter({
  owner,
  timeoutMs,
  isIdle,
  waiters,
  notifyIfIdle,
  abort,
}: DrainWaiterParams): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`${owner} drain timeout must be a non-negative finite number.`);
  }
  if (isIdle()) return Promise.resolve("flushed");
  // 预算为 0（异常退出路径）时没有可等待的窗口：直接执行 timer 回调本该做的
  // 事——abort 在途 Telegram 请求并结算，而不是把校验错误抛回 dispose()。
  if (timeoutMs === 0) {
    abort();
    return Promise.resolve("timedOut");
  }
  return new Promise((resolve: (value: FlushResult | PromiseLike<FlushResult>) => void): void => {
    let settled: boolean = false;
    function finish(result: FlushResult): void {
      if (settled) return;
      settled = true;
      waiters.delete(onIdle);
      clearTimeout(timer);
      resolve(result);
    }
    const onIdle = (): void => finish("flushed");
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      abort();
      finish("timedOut");
    }, timeoutMs);
    waiters.add(onIdle);
    notifyIfIdle();
  });
}
