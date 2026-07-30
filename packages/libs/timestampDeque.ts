/**
 * 有界数字时间戳双端队列。仅保存 number，使用可增长的连续数组和环形下标，
 * 避免消息级滑动窗口为每个时间戳创建链表节点。
 *
 * backing array 从小容量起步并最多增长到构造时给定的硬上限；clear 只重置下标，
 * 数组里残留的是原始 number，不会钉住对象引用。实例只用于进程内窗口，不承担
 * 持久化格式或跨线程共享。
 */
export class TimestampDeque {
  private values: number[];
  private head: number = 0;
  private count: number = 0;
  private readonly maxCapacity: number;

  constructor(
    maxCapacity: number,
    initialCapacity: number = Math.min(4, maxCapacity)
  ) {
    if (!Number.isSafeInteger(maxCapacity) || maxCapacity <= 0) {
      throw new RangeError("maxCapacity must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(initialCapacity) ||
      initialCapacity <= 0 ||
      initialCapacity > maxCapacity
    ) {
      throw new RangeError(
        "initialCapacity must be a positive safe integer no greater than maxCapacity"
      );
    }
    this.maxCapacity = maxCapacity;
    this.values = new Array<number>(initialCapacity);
  }

  get size(): number {
    return this.count;
  }

  /** 追加一个时间戳；达到构造时的硬上限表示调用方违反了领域容量约束。 */
  push(value: number): void {
    if (this.count === this.values.length) {
      if (this.count === this.maxCapacity) {
        throw new RangeError("TimestampDeque capacity exceeded");
      }
      this.grow();
    }
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

  /** 移除并返回最早时间戳。 */
  shift(): number | undefined {
    if (this.count === 0) return undefined;
    const value: number | undefined = this.values[this.head];
    this.head = (this.head + 1) % this.values.length;
    this.count -= 1;
    if (this.count === 0) this.head = 0;
    return value;
  }

  /** 移除并返回最新时间戳，供系统时钟回拨时原地裁掉未来尾段。 */
  pop(): number | undefined {
    if (this.count === 0) return undefined;
    const index: number =
      (this.head + this.count - 1) % this.values.length;
    const value: number | undefined = this.values[index];
    this.count -= 1;
    if (this.count === 0) this.head = 0;
    return value;
  }

  /** 查看最早时间戳但不移除。 */
  peek(): number | undefined {
    return this.count === 0 ? undefined : this.values[this.head];
  }

  /** 查看最新时间戳但不移除。 */
  peekLast(): number | undefined {
    if (this.count === 0) return undefined;
    const index: number =
      (this.head + this.count - 1) % this.values.length;
    return this.values[index];
  }

  /**
   * 就地保留半开窗口 `(now - windowMs, now]`。直接操作环形下标，避免热路径
   * 为每次修剪跨多个公开队列方法调用；未来尾段处理系统时钟回拨。
   */
  trim(windowMs: number, now: number): void {
    while (this.count > 0) {
      const tailIndex: number =
        (this.head + this.count - 1) % this.values.length;
      if ((this.values[tailIndex] ?? now) <= now) break;
      this.count -= 1;
    }
    const cutoff: number = now - windowMs;
    while (
      this.count > 0 &&
      (this.values[this.head] ?? Number.POSITIVE_INFINITY) <= cutoff
    ) {
      this.head = (this.head + 1) % this.values.length;
      this.count -= 1;
    }
    if (this.count === 0) this.head = 0;
  }

  /** 清空逻辑内容并保留已扩好的数值 backing array，供同一热窗口复用。 */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  private grow(): void {
    const previous: number[] = this.values;
    const nextCapacity: number = Math.min(
      this.maxCapacity,
      previous.length * 2
    );
    const replacement: number[] = new Array<number>(nextCapacity);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}
