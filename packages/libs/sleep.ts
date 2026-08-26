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

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}
