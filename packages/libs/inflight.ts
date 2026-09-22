/** 把 Promise 按本体登记到 Set，成功或失败后再移除；多个并发请求不会覆盖。 */
export function trackInflight<T>(inflight: Set<Promise<unknown>>, request: Promise<T>): Promise<T> {
  inflight.add(request);
  void request.then(
    (): boolean => inflight.delete(request),
    (): boolean => inflight.delete(request)
  );
  return request;
}

/**
 * 停机 / 排空预算必须是非负有限毫秒数，否则抛 RangeError。
 * @param timeoutMs 调用方收到的预算。
 * @param label 出现在报错里的英文预算名，例如 `Cron drain timeout`。
 */
export function assertTimeoutMs(timeoutMs: number, label: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`${label} must be a non-negative finite number.`);
  }
}

/**
 * 在预算内等待调用时的一批在途任务全部结算；失败同样算结算，不中断底层任务。
 * 调用方负责关闭新任务入口、处理任务错误和零预算策略；计时器不阻止进程退出。
 */
export function settleWithinBudget(
  tasks: Iterable<Promise<unknown>>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve: (settled: boolean) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      (): void => {
        clearTimeout(timer);
        resolve(false);
      },
      timeoutMs
    );
    timer.unref();
    void Promise.allSettled(tasks).then((): void => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 按预算排空一组已接纳的在途任务：集合为空，或预算内全部结算（失败同样算结算）
 * 时返回 "flushed"；零预算或预算耗尽时先 abort controller 取消排队与在途任务，
 * 再返回 "timedOut"。调用方负责先用 assertTimeoutMs 校验预算并关闭新任务入口。
 */
export async function drainTrackedTasks(
  tasks: ReadonlySet<Promise<unknown>>,
  controller: AbortController,
  timeoutMs: number
): Promise<"flushed" | "timedOut"> {
  if (tasks.size === 0) return "flushed";
  if (timeoutMs > 0 && await settleWithinBudget(tasks, timeoutMs)) return "flushed";
  controller.abort();
  return "timedOut";
}
