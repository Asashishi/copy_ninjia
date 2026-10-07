/**
 * 按 key 分组的串行异步任务队列：每个 key 各有一条 Promise 链，同一个 key
 * 内严格按提交顺序执行，不同 key 互不影响。链的状态本体（当前尾部 Promise）
 * 由调用方在各自的 cache/ 模块里持有并传入，本模块不持有任何 Map；空闲的 key
 * （链跑完且没有新任务顶替）自动从传入的 Map 里删除。
 *
 * 链里只存吸收了结果与异常的尾部，上一项无论成功或失败都推进下一项；任务自身的结果与
 * 异常原样交回 run 的调用方（调用方：workers/antiRaid/lockdownApi.ts 的 runLockdownApiCall、
 * workers/aiChat/compaction.ts 的 scheduleRotation、translate/message.ts 的 queueTranslateMessage、
 * 动态黑名单逐身份处置的 cache/main/blocklist.ts 的 blocklistIdentityMutationRunner）。
 */
export interface KeyedSerialTaskRunner<K> {
  /**
   * 把 task 挂到 key 对应的串行链尾部，在前一项结算后执行。返回 task 自身的结果；task
   * 抛错或 reject 时返回的 Promise 随之 reject，链照常推进。
   */
  readonly run: <T>(key: K, task: () => T | Promise<T>) => Promise<T>;
}

/** 链尾吸收任务结果与异常的共用回调，每次 run 不另建闭包。 */
function ignoreSettled(): undefined {
  return undefined;
}

export function createKeyedSerialTaskRunner<K>(chains: Map<K, Promise<void>>): KeyedSerialTaskRunner<K> {
  return {
    run<T>(key: K, task: () => T | Promise<T>): Promise<T> {
      const result: Promise<T> = (chains.get(key) ?? Promise.resolve()).then(task);
      const tail: Promise<void> = result.then(ignoreSettled, ignoreSettled);
      chains.set(key, tail);
      void tail.then((): void => {
        if (chains.get(key) === tail) chains.delete(key);
      });
      return result;
    },
  };
}
