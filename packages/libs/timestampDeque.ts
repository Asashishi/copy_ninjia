import { assertDequeCapacities } from "./dequeCapacity";

/**
 * 有界数字时间戳双端队列。仅保存 number，使用可增长的连续数组和环形下标。
 *
 * backing array 从小容量起步并最多增长到构造时给定的硬上限；clear 只重置下标，
 * 数组里残留的是原始 number，不持有对象引用。实例只用于进程内窗口，不承担
 * 持久化格式或跨线程共享。
 *
 * 容量是会抛错的硬顶：只承载配额本身就封住长度的窗口（构造时把容量取成那个
 * 配额上限）。没有上界的任务队列见 libs/linkedQueue.ts 的头注。
 *
 * 与 libs/boundedDeque.ts 的环形下标逻辑同构，两者各自存储，共用校验见
 * libs/dequeCapacity.ts。
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
   * 折回环内。
   */
  private tailIndex(): number {
    const length: number = this.values.length;
    const index: number = this.head + this.count - 1;
    return index >= length ? index - length : index;
  }

  /** 追加一个时间戳；已达构造时的硬上限时抛 RangeError。 */
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

  /**
   * 追加时间戳；达到硬上限时原地覆盖最早一项并返回被覆盖值。
   *
   * 仅供已经定义饱和语义的窗口使用；普通配额窗口调用 push，违反容量不变量的写入抛错。
   */
  pushReplacingOldest(value: number): number | undefined {
    if (this.count < this.maxCapacity) {
      this.push(value);
      return undefined;
    }
    const replaced: number | undefined = this.values[this.head];
    this.values[this.head] = value;
    const next: number = this.head + 1;
    this.head = next === this.values.length ? 0 : next;
    return replaced;
  }

  /** 查看最早时间戳但不移除。 */
  peek(): number | undefined {
    return this.count === 0 ? undefined : this.values[this.head];
  }

  /** 查看从最早算起第 offset 个时间戳（0 为最早）但不移除；越界返回 undefined。 */
  peekAt(offset: number): number | undefined {
    if (offset < 0 || offset >= this.count) return undefined;
    const length: number = this.values.length;
    let index: number = this.head + offset;
    if (index >= length) index -= length;
    return this.values[index];
  }

  /**
   * 移除第一个与 value 全等的时间戳；原地移动后续数字，不分配链表节点或临时数组。
   */
  removeValue(value: number): boolean {
    const length: number = this.values.length;
    let foundOffset: number = -1;
    for (let offset: number = 0; offset < this.count; offset += 1) {
      let index: number = this.head + offset;
      if (index >= length) index -= length;
      if (this.values[index] === value) {
        foundOffset = offset;
        break;
      }
    }
    if (foundOffset < 0) return false;
    for (let offset: number = foundOffset; offset < this.count - 1; offset += 1) {
      let target: number = this.head + offset;
      if (target >= length) target -= length;
      let source: number = target + 1;
      if (source === length) source = 0;
      this.values[target] = this.values[source] ?? 0;
    }
    this.count -= 1;
    if (this.count === 0) this.head = 0;
    return true;
  }

  /**
   * 就地保留半开窗口 `(now - windowMs, now]`。直接操作环形下标，不跨多个公开队列
   * 方法调用。
   *
   * 全仓滑动窗口的边界定义就是这里。
   * 另外两种数组形态（`trimSlidingWindowArray` 与 `trimSlidingWindowArrayInPlace`，用于
   * 要随快照落盘的窗口）位于 libs/slidingWindowRateLimit.ts，与本方法逐字一致；该约束由
   * test/libs/slidingWindowBoundary.test.ts 的同输入对拍锁住。
   *
   * 两步，按执行顺序：
   * 1. 系统时钟回拨后队尾会落在「未来」，只丢这些越界项，保留仍然合法的历史记录，
   *    不整窗清空；
   * 2. 丢掉已滑出窗口的队首（`ts <= now - windowMs`）。
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
