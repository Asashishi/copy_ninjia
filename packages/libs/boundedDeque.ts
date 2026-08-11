import { assertDequeCapacities } from "./dequeCapacity";

/**
 * 有界引用双端队列。使用可增长的环形数组，避免长期高频队列为每个元素额外
 * 创建链表节点；移出元素时立即清掉 backing slot，不能让已淘汰对象被数组继续
 * 引用。只承载进程内状态，不改变任何持久化或跨线程格式。
 */
export class BoundedDeque<T> {
  private values: (T | undefined)[];
  private head: number = 0;
  private count: number = 0;
  private readonly maxCapacity: number;

  constructor(
    maxCapacity: number,
    initialCapacity: number = Math.min(4, maxCapacity)
  ) {
    assertDequeCapacities(maxCapacity, initialCapacity);
    this.maxCapacity = maxCapacity;
    this.values = new Array<T | undefined>(initialCapacity);
  }

  get size(): number {
    return this.count;
  }

  /** 追加一个引用；达到构造时的硬上限表示调用方违反了领域容量约束。 */
  push(value: T): void {
    if (this.count === this.values.length) {
      if (this.count === this.maxCapacity) {
        throw new RangeError("BoundedDeque capacity exceeded");
      }
      this.grow();
    }
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

  /** 移除并返回队首，同时立即解除 backing array 对该值的引用。 */
  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const value: T | undefined = this.values[this.head];
    this.values[this.head] = undefined;
    this.head = (this.head + 1) % this.values.length;
    this.count -= 1;
    if (this.count === 0) this.head = 0;
    return value;
  }

  /** 返回队尾最近的 n 项快照，保持入队顺序。 */
  last(n: number): T[] {
    const length: number = Math.max(0, Math.min(this.count, n));
    const output: T[] = new Array<T>(length);
    const start: number = this.count - length;
    for (let index: number = 0; index < length; index += 1) {
      output[index] = this.values[
        (this.head + start + index) % this.values.length
      ]!;
    }
    return output;
  }

  /** 清空并解除全部活动引用，保留已扩好的 backing array 供同一 owner 复用。 */
  clear(): void {
    for (let index: number = 0; index < this.count; index += 1) {
      const slot: number = (this.head + index) % this.values.length;
      this.values[slot] = undefined;
    }
    this.head = 0;
    this.count = 0;
  }

  private grow(): void {
    const previous: (T | undefined)[] = this.values;
    const nextCapacity: number = Math.min(
      this.maxCapacity,
      previous.length * 2
    );
    const replacement: (T | undefined)[] =
      new Array<T | undefined>(nextCapacity);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length];
    }
    this.values = replacement;
    this.head = 0;
  }
}
