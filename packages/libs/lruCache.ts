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

/** 只暴露读取与迭代能力的 LRU 视图；调用方不能绕过 owner 改写缓存。 */
export interface ReadonlyLruCache<K, V> extends Iterable<readonly [K, V]> {
  readonly size: number;
  has(key: K): boolean;
  get(key: K): V | undefined;
  peek(key: K): V | undefined;
  keys(): IterableIterator<K>;
}

export class LruCache<K, V> implements ReadonlyLruCache<K, V> {
  private readonly map: Map<K, LruNode<K, V>> = new Map();
  private oldest: LruNode<K, V> | null = null;
  private newest: LruNode<K, V> | null = null;
  /**
   * 最近一次摘链的节点与它当时的后继，供**正停在该节点上的迭代器**继续前进。
   *
   * 只留一格、且挂在缓存上而不是节点上。假如改成逐节点存一个 `node.detached`：
   * 一个还活着的条目会指着一个已被淘汰的节点，那个节点又指着下一个，长期运行下
   * 拖出一条只增不减的死节点链——正是本类要避免的那类无界增长。单槽的代价是
   * 「一次迭代推进之间摘了不止一条链」时让位信息会被覆盖，见 [Symbol.iterator]。
   *
   * 保留量的上界写死在这里：任何时刻至多多留住**一个**已删除节点连同它的取值
   * （`delete` 之后、下一次摘链之前）。这两格随缓存生死，`clear` 一并归零。
   */
  private detachedNode: LruNode<K, V> | null = null;
  private detachedSuccessor: LruNode<K, V> | null = null;

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
   *  命中判据是「有没有这个 node」而不是「取值是不是 undefined」：后者会把
   *  "存了 undefined 值的键"误判成未命中，既返回值分不清真假未命中，还会跳过
   *  命中本该做的热度刷新，让该项永不被 LRU 提升、每次读都像未命中。 */
  get(key: K): V | undefined {
    const node: LruNode<K, V> | undefined = this.map.get(key);
    if (node === undefined) return undefined;
    this.touch(node);
    return node.value;
  }

  /** 不影响使用顺序地查看一个键的当前值：用于"这个 key 现在还是不是我
   *  插入的那份"之类的引用比对场景——这种内部核对不该被当成一次真实的
   *  访问去刷新它的淘汰顺位。 */
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

  /** 清空全部条目（仅供单测重置状态用）。 */
  clear(): void {
    this.map.clear();
    this.oldest = null;
    this.newest = null;
    this.detachedNode = null;
    this.detachedSuccessor = null;
  }

  /**
   * 按当前 LRU 顺序（最久未使用在前）迭代；不创建投影数组，也不改变条目热度。
   *
   * 追加、删除与 touch 尚未访问或已访问条目时按当前链表位置继续。改写**正停在
   * 的那一条**时靠上方的让位单槽前进，不漏掉它后面的条目；该条目被移到最新端
   * 时最多再产出一次，然后迭代正常结束。`antiRaid/lockdownMirror.ts` 的
   * recoverAbandonedLockdowns 依赖这一语义。
   *
   * 让位槽只有一格，两种情形下会失效并让本次迭代提前结束：一次推进之间摘掉了
   * 不止一条链（后者覆盖前者），以及在遍历体里又起一次对同一份缓存的嵌套遍历
   * （内层会作废外层的让位）。真要在遍历中批量删除或嵌套遍历，先取快照
   * （`[...cache]`）——全仓当前没有这样的调用点。
   */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    let node: LruNode<K, V> | null = this.oldest;
    while (node !== null) {
      const current: LruNode<K, V> = node;
      // 产出前先作废让位槽：它只对**本次产出之后**发生的摘链有效。留着上一次
      // 操作写下的旧值会让迭代甩回一个更早的后继，绕成环。
      this.detachedNode = null;
      yield [current.key, current.value];
      node = this.detachedNode === current ? this.detachedSuccessor : current.newer;
    }
  }

  /** 按当前 LRU 顺序迭代主键；不改变条目热度，迭代期改写语义同 [Symbol.iterator]。 */
  *keys(): IterableIterator<K> {
    let node: LruNode<K, V> | null = this.oldest;
    while (node !== null) {
      const current: LruNode<K, V> = node;
      this.detachedNode = null;
      yield current.key;
      node = this.detachedNode === current ? this.detachedSuccessor : current.newer;
    }
  }

  /** 命中续命：已经在最新端时不做无效指针写入。 */
  private touch(node: LruNode<K, V>): void {
    if (this.newest === node) return;
    this.unlink(node);
    this.linkNewest(node);
  }

  /**
   * 把节点从链上摘下来，并把它当时的后继留在让位槽里。
   *
   * **只能对仍在链上的节点调用。** 对已经摘过的节点再摘一次，它的
   * `newer`/`older` 都是 null，两个分支会把 `newest` 与 `oldest` 一起置空——
   * Map 里条目还在，链却空了，此后迭代什么都不产出、淘汰也找不到最旧项，
   * 而且不报任何错。三个调用点都已经保证这一点：`delete` 先查 Map 决定要不要摘，
   * `touch` 摘完立刻重新挂上，容量淘汰摘的是 `this.oldest`。新增调用点必须自己
   * 先确认节点还在链上。这里不加运行期断言——它落在每次命中续命的路径上。
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
    this.detachedNode = node;
    this.detachedSuccessor = newer;
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
