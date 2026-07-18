/**
 * 按 key 分组的串行异步任务队列：同一个 key 内严格按提交顺序执行（对
 * serialTaskRunner.ts 单链思路的推广，按 key 各开一条独立链），不同 key
 * 互不影响。链的状态本体（当前尾部 Promise）由调用方在各自的 cache/ 模块
 * 里持有并传入——对齐本项目「状态本体只在 cache/」的原则，本模块自己不
 * 持有任何 Map；空闲的 key（链跑完且没有新任务顶替）自动从传入的 Map 里
 * 删除，避免历史 key 无限累积。
 *
 * task 的失败与成功统一对待、都会推进链：与 serialTaskRunner.ts 靠 onError
 * 回调统一收口不同，这里没有 onError——现有调用方（
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
        () => {
          if (chains.get(key) === next) chains.delete(key);
        },
        () => {
          if (chains.get(key) === next) chains.delete(key);
        }
      );
      return next;
    },
  };
}
