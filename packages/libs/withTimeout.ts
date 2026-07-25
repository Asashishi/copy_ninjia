/**
 * 通用超时竞速：给一个已经在途、无法取消的 Promise 加上时间上限。
 * 超时只让调用方的等待结束，不会真正中断底层任务——需要中断的 owner 必须
 * 自己在 catch 分支里 abort。
 */

/**
 * 等待 task，最多 timeoutMs 毫秒；超时以 Error 拒绝。
 * @param task 已经在途的任务；本函数不负责取消它。
 * @param timeoutMs 上限毫秒数，必须是非负有限值。
 * @param operation 出现在超时错误文案里的操作名（英文，见 AGENTS.md 日志约定）。
 */
export function withTimeout<T>(task: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<T>((_resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void): void => {
      timer = setTimeout(
        (): void => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      // 超时 timer 不应把进程留在事件循环里：竞速的另一侧才是真正的工作。
      timer.unref();
    }),
  ]).finally((): void => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
