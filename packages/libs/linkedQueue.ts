/**
 * 单向链表实现的 FIFO 队列，供各处滚动窗口/任务队列使用。
 * 数组的 shift() 出队要整体挪动剩余元素（O(n)），链表出队是 O(1)。
 */

interface QueueNode<T> {
  value: T;
  next: QueueNode<T> | null;
}

export class LinkedQueue<T> {
  private head: QueueNode<T> | null = null;
  private tail: QueueNode<T> | null = null;
  private count: number = 0;

  get size(): number {
    return this.count;
  }

  /** 入队（追加到队尾）。 */
  push(value: T): void {
    const node: QueueNode<T> = { value, next: null };
    if (this.tail) {
      this.tail.next = node;
    } else {
      this.head = node;
    }
    this.tail = node;
    this.count += 1;
  }

  /** 出队（移除并返回队首）；队列为空时返回 undefined。 */
  shift(): T | undefined {
    const node: QueueNode<T> | null = this.head;
    if (!node) return undefined;
    this.head = node.next;
    if (!this.head) {
      this.tail = null;
    }
    this.count -= 1;
    return node.value;
  }

  /** 查看队首元素但不出队；队列为空时返回 undefined。 */
  peek(): T | undefined {
    return this.head ? this.head.value : undefined;
  }

  /** 整体清空。摘掉 head/tail 让整条链一起变成垃圾，O(1)，不必逐个 shift。
   *  用于滑动窗口遇到系统时钟回拨时按新时间轴重建，见
   *  libs/slidingWindowRateLimit.ts。 */
  clear(): void {
    this.head = null;
    this.tail = null;
    this.count = 0;
  }

  /** 取队尾最近的 n 个元素，保持入队顺序；n 大于队列长度时返回全部。
   *  n=1 走 tail 指针 O(1) 特判（replyQueue 每次入队都取最新一条），其余
   *  情况单链表只能从头遍历。 */
  last(n: number): T[] {
    if (n === 1) return this.tail ? [this.tail.value] : [];
    const skip: number = Math.max(0, this.count - n);
    const out: T[] = [];
    let index: number = 0;
    for (let node: QueueNode<T> | null = this.head; node; node = node.next) {
      if (index >= skip) {
        out.push(node.value);
      }
      index += 1;
    }
    return out;
  }

  /** 移除队列中第一个与 value 全等（===）的节点，不影响其余元素的相对顺序；
   *  找不到则什么都不做并返回 false。O(n) 线性扫描——单链表没有 prev 指针，
   *  移除非队首节点必须从头找起，不像 shift() 那样能 O(1)。用于按值精确
   *  撤销某次入队（而非无差别地 shift 队首），见 antiRaid 的 recordJoin/
   *  retractJoin：撤销一次刷群窗口计数时，要撤的必须是那一次入群自己的
   *  时间戳，不能牵连其它仍在窗口内的入群——若该时间戳已经被自然修剪出局
   *  （早于窗口的 while 循环清理掉了），说明无需撤销，找不到即返回 false。 */
  removeValue(value: T): boolean {
    let prev: QueueNode<T> | null = null;
    for (let node: QueueNode<T> | null = this.head; node; node = node.next) {
      if (node.value === value) {
        if (prev) {
          prev.next = node.next;
        } else {
          this.head = node.next;
        }
        if (this.tail === node) {
          this.tail = prev;
        }
        this.count -= 1;
        return true;
      }
      prev = node;
    }
    return false;
  }

  /**
   * 一次线性扫描移除所有满足条件的节点，并保持其余元素的相对顺序。
   *
   * 适合 teardown 这类低频的批量撤销；不能拿到高频容量淘汰热路径里反复调用，
   * 否则每删一个值都重扫整条链，会退化成 O(n²)。
   * @returns 实际移除的节点数。
   */
  removeWhere(predicate: (value: T) => boolean): number {
    let previous: QueueNode<T> | null = null;
    let node: QueueNode<T> | null = this.head;
    let removed: number = 0;
    while (node !== null) {
      const next: QueueNode<T> | null = node.next;
      if (predicate(node.value)) {
        if (previous === null) {
          this.head = next;
        } else {
          previous.next = next;
        }
        if (this.tail === node) this.tail = previous;
        this.count -= 1;
        removed += 1;
      } else {
        previous = node;
      }
      node = next;
    }
    return removed;
  }
}
