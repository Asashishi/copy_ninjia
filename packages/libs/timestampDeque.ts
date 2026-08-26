import { assertDequeCapacities } from "./dequeCapacity";

/**
 * 有界数字时间戳双端队列。仅保存 number，使用可增长的连续数组和环形下标，
 * 避免消息级滑动窗口为每个时间戳创建链表节点。
 *
 * backing array 从小容量起步并最多增长到构造时给定的硬上限；clear 只重置下标，
 * 数组里残留的是原始 number，不会钉住对象引用。实例只用于进程内窗口，不承担
 * 持久化格式或跨线程共享。
 *
 * **容量是会抛错的硬顶**：只承载配额本身就封住长度的窗口（构造时把容量取成那个
 * 配额上限即可）。没有上界的窗口用 libs/linkedQueue.ts，见
 * libs/slidingWindowRateLimit.ts 的头注。
 *
 * 与 libs/boundedDeque.ts 的环形下标逻辑同构，但**刻意不合并成一个泛型**：
 * 理由与共用校验的取舍写在 libs/dequeCapacity.ts 的头注里。
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
    assertDequeCapacities(maxCapacity, initialCapacity);
    this.maxCapacity = maxCapacity;
    this.values = new Array<number>(initialCapacity);
  }

  get size(): number {
    return this.count;
  }

  /**
   * 队尾槽位。`head + count - 1` 恒小于 `2 * values.length`，一次条件减即可
   * 折回环内；取模在这里会让每条群消息都付一次整数除法。
   */
  private tailIndex(): number {
    const length: number = this.values.length;
    const index: number = this.head + this.count - 1;
    return index >= length ? index - length : index;
  }

  /** 追加一个时间戳；达到构造时的硬上限表示调用方违反了领域容量约束。 */
  push(value: number): void {
    if (this.count === this.values.length) {
      if (this.count === this.maxCapacity) {
        throw new RangeError("TimestampDeque capacity exceeded");
      }
      this.grow();
    }
    const length: number = this.values.length;
    let index: number = this.head + this.count;
    if (index >= length) index -= length;
    this.values[index] = value;
    this.count += 1;
  }

  /** 移除并返回最早时间戳。 */
  shift(): number | undefined {
    if (this.count === 0) return undefined;
    const value: number | undefined = this.values[this.head];
    const next: number = this.head + 1;
    this.head = next === this.values.length ? 0 : next;
    this.count -= 1;
    if (this.count === 0) this.head = 0;
    return value;
  }

  /** 移除并返回最新时间戳，供系统时钟回拨时原地裁掉未来尾段。 */
  pop(): number | undefined {
    if (this.count === 0) return undefined;
    const value: number | undefined = this.values[this.tailIndex()];
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
    return this.values[this.tailIndex()];
  }

  /**
   * 就地保留半开窗口 `(now - windowMs, now]`。直接操作环形下标，避免热路径
   * 为每次修剪跨多个公开队列方法调用。
   *
   * **全仓滑动窗口的边界定义就是这里**，调用方不要各自手写
   * `while (peek() < cutoff) shift()`：`<` / `<=` / `>=` 的写法差一个刻度，
   * 同样的窗口长度会因为读的是哪份副本而得出不同结论。另外两种形态
   * （无硬顶窗口的 `trimSlidingWindow`、要随快照落盘的
   * `trimSlidingWindowArray`，都在 libs/slidingWindowRateLimit.ts）必须与本方法
   * 逐字一致，该约束由 test/libs/slidingWindowBoundary.test.ts 的同输入对拍锁住。
   *
   * 两件事：
   * 1. 丢掉已滑出窗口的队首（`ts <= now - windowMs`）；
   * 2. 系统时钟回拨后队尾会落在「未来」，**只丢这些越界项**，保留仍然合法的
   *    历史记录。绝不能整窗清空：那等于把配额清零重来，往回拨 1 毫秒就能凭空
   *    换到一整个新窗口，限流形同虚设。
   */
  trim(windowMs: number, now: number): void {
    while (this.count > 0) {
      if ((this.values[this.tailIndex()] ?? now) <= now) break;
      this.count -= 1;
    }
    const cutoff: number = now - windowMs;
    const length: number = this.values.length;
    while (
      this.count > 0 &&
      (this.values[this.head] ?? Number.POSITIVE_INFINITY) <= cutoff
    ) {
      const next: number = this.head + 1;
      this.head = next === length ? 0 : next;
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
    const length: number = previous.length;
    for (let index: number = 0; index < this.count; index += 1) {
      let slot: number = this.head + index;
      if (slot >= length) slot -= length;
      replacement[index] = previous[slot] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}
