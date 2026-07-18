/**
 * 只保留「当前正在处理的值 + 最新待处理值」的异步写入器。
 *
 * 高频状态变化若为每个快照都排一次磁盘写，会让慢磁盘后面堆出一条没有
 * 上限的 Promise 链，并同时保留许多已经过时的大字符串。本工具把中间快照
 * 合并掉：正在写的不能撤销，写入期间到达的更新只保留最后一份。
 */
export interface LatestValueRunner<T> {
  push(value: T): Promise<void>;
}

export function createLatestValueRunner<T>(consume: (value: T) => Promise<void>): LatestValueRunner<T> {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    let latestError: unknown;
    let latestFailed: boolean = false;
    while (pending !== null) {
      const current: { value: T } = pending;
      pending = null;
      try {
        await consume(current.value);
        // 中间旧值失败、但更新的值成功时，调用方关心的最新状态已经持久化，
        // 不应继续把整批 promise 误报为失败。
        latestError = undefined;
        latestFailed = false;
      } catch (error: unknown) {
        // 单次失败不能把期间到达的最新值永久搁在内存里；继续排空，最终
        // 只以最新一次实际消费的结果结算。
        latestError = error;
        latestFailed = true;
      }
    }
    // 必须在 drain 自己返回前同步清空；若放在 promise.finally，循环结束与
    // finally 执行之间的微任务缝隙会让新 push 误接到已完成的旧 promise。
    running = null;
    if (latestFailed) throw latestError;
  };

  return {
    push(value: T): Promise<void> {
      pending = { value };
      running ??= drain();
      return running;
    },
  };
}
