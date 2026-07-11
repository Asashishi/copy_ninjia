/**
 * 单向链表实现的 FIFO 队列,供各处滚动窗口/任务队列使用。
 * 数组的 shift() 出队要整体挪动剩余元素(O(n)),链表的出队是 O(1)。
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

  /** 入队(追加到队尾)。 */
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

  /** 出队(移除并返回队首);队列为空时返回 undefined。 */
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

  /** 查看队首元素但不出队;队列为空时返回 undefined。 */
  peek(): T | undefined {
    return this.head ? this.head.value : undefined;
  }

  /** 取队尾最近的 n 个元素,保持入队顺序;n 大于队列长度时返回全部。 */
  last(n: number): T[] {
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
}
