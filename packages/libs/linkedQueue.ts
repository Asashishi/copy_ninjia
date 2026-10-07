/**
 * 单向链表实现的 FIFO 队列，供任务队列与没有容量上界的队列使用；出队 O(1)，
 * 每入队一个元素分配一个节点对象。有硬顶的数值窗口使用 libs/timestampDeque.ts。
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

  /** 只读遍历当前 FIFO；遍历期间调用方不得修改队列，用于恢复时核对已有事实。 */
  *values(): IterableIterator<T> {
    for (let node: QueueNode<T> | null = this.head; node !== null; node = node.next) yield node.value;
  }

  /** 整体清空。摘掉 head/tail 让整条链一起变成垃圾，O(1)，不逐个 shift。 */
  clear(): void {
    this.head = null;
    this.tail = null;
    this.count = 0;
  }

  /** 移除队列中第一个与 value 全等（===）的节点，不影响其余元素的相对顺序；
   *  找不到则什么都不做并返回 false。O(n) 线性扫描。用于取消仍在排队的任务。 */
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
   * 用于 teardown 这类低频的批量撤销；每次调用线性扫描整条链，不用于高频容量淘汰路径。
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
