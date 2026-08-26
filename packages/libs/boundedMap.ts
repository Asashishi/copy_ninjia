/** 向 Map 写入一项；新增键越过上限时淘汰最早插入项（FIFO，不刷新热度）。 */
export interface SetBoundedMapValueParams<K, V> {
  map: Map<K, V>;
  key: K;
  value: V;
  maxEntries: number;
}

export function setBoundedMapValue<K, V>({
  map,
  key,
  value,
  maxEntries,
}: SetBoundedMapValueParams<K, V>): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("maxEntries must be a positive safe integer");
  }
  if (!map.has(key) && map.size >= maxEntries) {
    const oldest: IteratorResult<K, undefined> = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** sweepExpiredSnapshots 的入参；两个 Anti-Raid 按需缓存共用同一套淘汰口径。 */
export interface SweepExpiredSnapshotsParams<TSnapshot extends { readonly fetchedAt: number }> {
  /** 待淘汰的按需快照表，键是 chatId。 */
  readonly snapshots: Map<number, TSnapshot>;
  /** 仍在拉取的群；这些群保留旧快照供同步快路径降级使用，不参与淘汰。 */
  readonly inFlight: ReadonlyMap<number, unknown>;
  /** 快照存活时长。 */
  readonly ttlMs: number;
  /** 判定用的当前时刻。 */
  readonly now: number;
}

/**
 * 按 TTL 淘汰按需快照，跳过仍在拉取的群。
 *
 * 「在途的群不淘汰」是语义而不是优化：同步快路径在拉取完成前依赖旧快照，
 * 扫掉它会让判定在窗口里退化成「不知道」。两个 owner
 * （cache/workers/antiRaid/admins.ts、linkedChannels.ts）共用这一淘汰口径。
 * @returns 本轮淘汰的条数。
 */
export function sweepExpiredSnapshots<TSnapshot extends { readonly fetchedAt: number }>({
  snapshots,
  inFlight,
  ttlMs,
  now,
}: SweepExpiredSnapshotsParams<TSnapshot>): number {
  let deleted: number = 0;
  for (const [chatId, cached] of snapshots) {
    if (now - cached.fetchedAt > ttlMs && !inFlight.has(chatId)) {
      snapshots.delete(chatId);
      deleted++;
    }
  }
  return deleted;
}
