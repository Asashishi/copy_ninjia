/**
 * 固定容量的 LRU 缓存。
 *
 * 命中不改写 Map，只原地调整侵入式双向链表的指针；条目使用固定 shape 的
 * `newer`/`older` 字段，缓存单独持有 `oldest`/`newest` 端点。容量由构造参数
 * 硬限制，新增第 maxEntries + 1 项时同步淘汰最旧节点。
 */

interface LruNode<K, V> {
  readonly key: K;
  value: V;
  /** 更新的一侧；`null` 表示本节点就是最新端。 */
  newer: LruNode<K, V> | null;
  /** 更旧的一侧；`null` 表示本节点就是最旧端。 */
  older: LruNode<K, V> | null;
}

export class LruCache<K, V> {
  private readonly map: Map<K, LruNode<K, V>> = new Map();
  private oldest: LruNode<K, V> | null = null;
  private newest: LruNode<K, V> | null = null;
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
   *  命中判据是「有没有这个 node」，不看取值是否为 undefined：存了 undefined 值的键
   *  同样命中并刷新热度。 */
  get(key: K): V | undefined {
    const node: LruNode<K, V> | undefined = this.map.get(key);
    if (node === undefined) return undefined;
    this.touch(node);
    return node.value;
  }

  /** 不影响使用顺序地查看一个键的当前值，用于"这个 key 现在还是不是我
   *  插入的那份"之类的引用比对。 */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** 写入一个键（新增或覆盖），视为一次最近使用；超容量时淘汰最久未使用的一项。 */
  set(key: K, value: V): void {
    const existing: LruNode<K, V> | undefined = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.touch(existing);
      return;
    }
    const node: LruNode<K, V> = { key, value, newer: null, older: null };
    this.map.set(key, node);
    this.linkNewest(node);
    if (this.map.size > this.maxEntries) {
      const oldest: LruNode<K, V> | null = this.oldest;
      if (oldest !== null) {
        this.map.delete(oldest.key);
        this.unlink(oldest);
      }
    }
  }

  delete(key: K): boolean {
    const node: LruNode<K, V> | undefined = this.map.get(key);
    if (node === undefined) return false;
    this.map.delete(key);
    this.unlink(node);
    return true;
  }

  /** 清空全部条目；用于 owner 整表重置（如 Disk I/O 重建后重新灌入计数时清空读取缓存）。 */
  clear(): void {
    this.map.clear();
    this.oldest = null;
    this.newest = null;
  }

  /** 命中续命：已经在最新端时不做无效指针写入。 */
  private touch(node: LruNode<K, V>): void {
    if (this.newest === node) return;
    this.unlink(node);
    this.linkNewest(node);
  }

  /**
   * 把节点从链上摘下来。
   *
   * 只能对仍在链上的节点调用：对已经摘过的节点再摘一次，会把 `newest` 与 `oldest`
   * 一起置空。三个调用点保证这一点：`delete` 先查 Map 决定要不要摘，`touch` 摘完
   * 立刻重新挂上，容量淘汰摘的是 `this.oldest`。新增调用点必须自己先确认节点还在链上；
   * 这里不加运行期断言。
   */
  private unlink(node: LruNode<K, V>): void {
    const newer: LruNode<K, V> | null = node.newer;
    const older: LruNode<K, V> | null = node.older;
    if (newer === null) this.newest = older;
    else newer.older = older;
    if (older === null) this.oldest = newer;
    else older.newer = newer;
    node.newer = null;
    node.older = null;
  }

  private linkNewest(node: LruNode<K, V>): void {
    const previousNewest: LruNode<K, V> | null = this.newest;
    node.newer = null;
    node.older = previousNewest;
    if (previousNewest === null) this.oldest = node;
    else previousNewest.newer = node;
    this.newest = node;
  }
}
