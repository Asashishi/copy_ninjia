/**
 * 按 key 分组的串行异步任务队列：每个 key 各有一条 Promise 链，同一个 key
 * 内严格按提交顺序执行，不同 key 互不影响。链的状态本体（当前尾部 Promise）
 * 由调用方在各自的 cache/ 模块里持有并传入——对齐本项目「状态本体只在
 * cache/」的原则，本模块自己不持有任何 Map；空闲的 key（链跑完且没有新
 * 任务顶替）自动从传入的 Map 里删除，避免历史 key 无限累积。
 *
 * prev.then(task, task) 让上一项失败或成功都能推进链。这里刻意没有全局
 * onError——现有调用方（
 * workers/antiRaid/lockdownRuntime.ts 的 runLockdownApiCall、
 * workers/aiChat/compaction.ts 的 scheduleRotation）的 task 自身都已经
 * try/catch 到底、从不真正 reject，若换成全局 onError 反而会丢失各自的
 * 错误上下文（哪个 chatId、在做哪一步）。
 */
export interface KeyedSerialTaskRunner<K> {
  /**
   * 把 task 挂到 key 对应的串行链尾部。返回这次挂载后的链尾 Promise——
   * 不需要在任务完成时机附加额外逻辑（如计数器维护）的调用方可以直接
   * 丢弃返回值。
   */
  run(key: K, task: () => Promise<void>): Promise<void>;
}

export function createKeyedSerialTaskRunner<K>(chains: Map<K, Promise<void>>): KeyedSerialTaskRunner<K> {
  return {
    run(key: K, task: () => Promise<void>): Promise<void> {
      const prev: Promise<void> = chains.get(key) ?? Promise.resolve();
      const next: Promise<void> = prev.then(task, task);
      chains.set(key, next);
      void next.then(
        (): void => {
          if (chains.get(key) === next) chains.delete(key);
        },
        (): void => {
          if (chains.get(key) === next) chains.delete(key);
        }
      );
      return next;
    },
  };
}
