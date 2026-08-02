/**
 * 基准自带的候选容器实现：滑动时间窗与环形缓冲。
 *
 * 取名 containers 而非 windows——这里同时住着 RollingBuffer，它不是"窗口"。
 *
 * 刻意不复用 packages/libs 下的实现：这两个类**就是被对比的候选方案**（普通
 * 数组 vs Float64Array），存在的意义是量出选型差异，因此必须留在基准侧，
 * 不能被生产实现的演进悄悄改写口径。
 */

export interface TimestampWindow {
  readonly size: number;
  push(value: number): void;
  trim(windowMs: number, now: number): void;
}

export interface RollingBuffer {
  readonly size: number;
  push(value: number): void;
  shift(): number | undefined;
  last(n: number): number[];
  clear(): void;
}

export class ArrayTimestampWindow implements TimestampWindow {
  private values: number[];
  private head: number = 0;
  private count: number = 0;

  constructor() {
    this.values = new Array<number>(4);
  }

  get size(): number {
    return this.count;
  }

  push(value: number): void {
    if (this.count === this.values.length) this.grow();
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

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

  private grow(): void {
    const previous: number[] = this.values;
    const replacement: number[] = new Array<number>(previous.length * 2);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}

export class Float64TimestampWindow implements TimestampWindow {
  private values: Float64Array;
  private head: number = 0;
  private count: number = 0;

  constructor() {
    this.values = new Float64Array(4);
  }

  get size(): number {
    return this.count;
  }

  push(value: number): void {
    if (this.count === this.values.length) this.grow();
    const index: number = (this.head + this.count) % this.values.length;
    this.values[index] = value;
    this.count += 1;
  }

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

  private grow(): void {
    const previous: Float64Array = this.values;
    const replacement: Float64Array = new Float64Array(previous.length * 2);
    for (let index: number = 0; index < this.count; index += 1) {
      replacement[index] =
        previous[(this.head + index) % previous.length] ?? 0;
    }
    this.values = replacement;
    this.head = 0;
  }
}

/**
 * 把若干原型方法收成探针表，键名统一为 `<label>.<方法名>`。
 *
 * 这里必须传原始方法本身：探针只被 bun:jsc 按函数身份读取、从不调用，包一层
 * 箭头函数会让 numberOfDFGCompiles 读到那个包装器而不是被测方法，读数恒为
 * 「包装器编译过一次」，彻底失去意义。也正因为从不调用，unbound 引用不会产生
 * 任何 this 绑定问题。
 */
