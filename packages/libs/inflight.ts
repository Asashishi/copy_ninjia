/** 把 Promise 按本体登记到 Set，成功或失败后再移除；多个并发请求不会覆盖。 */
export function trackInflight<T>(inflight: Set<Promise<unknown>>, request: Promise<T>): Promise<T> {
  inflight.add(request);
  void request.then(
    (): boolean => inflight.delete(request),
    (): boolean => inflight.delete(request)
  );
  return request;
}

/** 等待调用时仍登记着的全部请求 settle（成功失败都算落定）。用 allSettled
 *  而非 all：任何一个请求 reject 都不能让本函数提前返回、丢下其余仍在途的
 *  请求。调用方应先阻止新请求继续加入。 */
export async function settleInflight(inflight: ReadonlySet<Promise<unknown>>): Promise<void> {
  await Promise.allSettled(inflight);
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
