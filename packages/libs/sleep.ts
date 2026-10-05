/**
 * 睡眠 ms 毫秒。
 *
 * 不带 signal 时直接用 `Bun.sleep`：它同样是 referenced 的（pending 期间会把
 * 进程留在事件循环里），但省掉自建 timer 句柄、abort 监听与包装 Promise。
 * 带 signal 时仍需自己持有 timer 才能在停机时 clearTimeout 并立即 reject，
 * 并在结算时移除取消监听。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError("sleep duration must be finite and non-negative"));
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (signal === undefined) return Bun.sleep(ms);
  return new Promise((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 可被 signal 打断的睡眠：睡满返回 true；signal 已经或在等待期间中止返回 false，不抛错；
 * 其余错误（如非法时长）原样抛出。
 */
export async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch (error: unknown) {
    if (signal.aborted) return false;
    throw error;
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}
