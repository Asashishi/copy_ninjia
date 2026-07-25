/**
 * 固定容量的 LRU 缓存。借 Map 本身的保序特性实现——命中/写入都把该 key
 * 删了再插回去，挪到迭代序最新的一端；超容量时淘汰迭代序最旧的一个
 * （Map 的 keys() 顺序即插入顺序）。不需要额外的双向链表/节点指针，
 * 每次操作都是 O(1)。
 */
export class LruCache<K, V> {
  private readonly map: Map<K, V> = new Map();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
  }

  get size(): number {
    return this.map.size;
  }

  /** 键是否存在，不影响其位置（不算一次"使用"）。 */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** 读取一个键；命中时顺带把它标记为最近使用。未命中返回 undefined。
   *  用 has() 判断命中而非 `value === undefined`：后者会把"存了 undefined
   *  值的键"误判成未命中，既返回值分不清真假未命中，还会跳过命中本该
   *  做的热度刷新，让该项永不被 LRU 提升、每次读都像未命中。 */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value: V = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** 不影响使用顺序地查看一个键的当前值：用于"这个 key 现在还是不是我
   *  插入的那份"之类的引用比对场景——这种内部核对不该被当成一次真实的
   *  访问去刷新它的淘汰顺位。 */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** 写入一个键（新增或覆盖），视为一次最近使用；超容量时淘汰最久未使用的一项。 */
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      const oldest: IteratorResult<K, undefined> = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** 清空全部条目（仅供单测重置状态用）。 */
  clear(): void {
    this.map.clear();
  }
}
