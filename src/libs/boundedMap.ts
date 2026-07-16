/** 向 Map 写入一项；新增键越过上限时淘汰最早插入项（FIFO，不刷新热度）。 */
export function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("maxEntries must be a positive safe integer");
  }
  if (!map.has(key) && map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}
