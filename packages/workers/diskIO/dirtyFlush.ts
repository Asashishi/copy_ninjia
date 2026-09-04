/**
 * stickerCatalogFiles.ts 的 dirty 集合逐项写入循环：快照已不在缓存里（落盘前
 * 又被删除）就直接摘掉 dirty 标记；写成功才摘除，单项失败只 console.error
 * （journal 兜底，理由见 workers/diskIOWorker.ts 模块头）并保留标记。
 *
 * 不返回是否刷净：唯一调用方在重排定时器时本来就要读一次残留集合的 size，
 * 由它自己判，这里不再多给一个会被丢掉的布尔。
 *
 * aiMemoryFiles.ts 形状相似但不复用本实现：它要在摘掉 dirty 标记的同一边界
 * 结算 aiMemoryImmediateRevisions 并发出 aiMemoryPersisted 回执，那条回执的
 * 生命周期不属于通用循环。
 */
export interface FlushDirtyEntriesParams<K> {
  dirty: Set<K>;
  cache: Map<K, string>;
  write: (key: K, snapshot: string) => void;
  describeFailure: (key: K) => string;
}

export function flushDirtyEntries<K>({
  dirty,
  cache,
  write,
  describeFailure,
}: FlushDirtyEntriesParams<K>): void {
  for (const key of dirty) {
    const snapshot: string | undefined = cache.get(key);
    if (!snapshot) {
      dirty.delete(key);
      continue;
    }
    try {
      write(key, snapshot);
      dirty.delete(key);
    } catch (error: unknown) {
      console.error(describeFailure(key), error);
    }
  }
}
