import { LinkedQueue } from "./linkedQueue";

/** 从队列取出的唯一在途批次；对端 ACK 前由生产方保留以支持代际重发。 */
export interface AcknowledgedBatch<T> {
  readonly batchId: number;
  readonly values: readonly T[];
}

/** ACK 队列的批次、总条数与累计成本硬边界。 */
export interface AcknowledgedBatchQueueOptions {
  readonly maxBatchMessages: number;
  readonly maxMessages: number;
  readonly maxCost: number;
}

interface CostedQueueValue<T> {
  readonly value: T;
  readonly cost: number;
}

/**
 * 单向通道的 ACK 批处理队列。
 *
 * 队列只允许一个批次在途，避免对端停止消费时继续向 Worker mailbox 无界复制；
 * 在途值保留到 ACK，投递拒绝或对端代际崩溃后可原批重发，语义为 at-least-once。
 * 总条数与领域成本均有硬顶；enqueue 越界时返回 false，由领域 owner 决定丢弃、
 * 合并或升级。实例必须放进所属线程的 cache 模块。
 */
export class AcknowledgedBatchQueue<T> {
  private readonly queue: LinkedQueue<CostedQueueValue<T>> =
    new LinkedQueue<CostedQueueValue<T>>();
  private readonly maxBatchMessages: number;
  private readonly maxMessages: number;
  private readonly maxCost: number;
  private inFlight: AcknowledgedBatch<T> | null = null;
  private inFlightCost: number = 0;
  private queuedCost: number = 0;
  private delivered: boolean = false;
  private nextBatchId: number = 1;

  constructor({
    maxBatchMessages,
    maxMessages,
    maxCost,
  }: AcknowledgedBatchQueueOptions) {
    for (const [label, value] of [
      ["maxBatchMessages", maxBatchMessages],
      ["maxMessages", maxMessages],
      ["maxCost", maxCost],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
      }
    }
    this.maxBatchMessages = maxBatchMessages;
    this.maxMessages = maxMessages;
    this.maxCost = maxCost;
  }

  /** 当前排队与在途消息总数。 */
  get size(): number {
    return this.queue.size + (this.inFlight?.values.length ?? 0);
  }

  /** 排队与在途值合计占用的领域成本，供同一 owner 的组合预算判定。 */
  get retainedCost(): number {
    return this.queuedCost + this.inFlightCost;
  }

  /** 是否有一批已经成功提交给对端、正在等待确认。 */
  get awaitingAcknowledgement(): boolean {
    return this.inFlight !== null && this.delivered;
  }

  /** 在条数与成本均有余量时追加；越界不改变 FIFO。 */
  enqueue(value: T, cost: number): boolean {
    if (!Number.isSafeInteger(cost) || cost <= 0) {
      throw new RangeError("cost must be a positive safe integer");
    }
    if (
      this.size >= this.maxMessages ||
      cost > this.maxCost - this.retainedCost
    ) {
      return false;
    }
    this.queue.push({ value, cost });
    this.queuedCost += cost;
    return true;
  }

  /**
   * 返回下一批需要投递的值。同步拒绝或代际崩溃后返回同一批；成功提交且尚未
   * ACK 时返回 null，保证 mailbox 里最多只有一个本通道批次。
   */
  nextDelivery(): AcknowledgedBatch<T> | null {
    if (this.inFlight !== null) return this.delivered ? null : this.inFlight;
    if (this.queue.size === 0) return null;
    const values: T[] = [];
    let inFlightCost: number = 0;
    while (values.length < this.maxBatchMessages) {
      const entry: CostedQueueValue<T> | undefined = this.queue.shift();
      if (entry === undefined) break;
      values.push(entry.value);
      inFlightCost += entry.cost;
    }
    this.queuedCost -= inFlightCost;
    this.inFlightCost = inFlightCost;
    const batchId: number = this.nextBatchId;
    this.nextBatchId = this.nextBatchId === Number.MAX_SAFE_INTEGER ? 1 : this.nextBatchId + 1;
    this.inFlight = { batchId, values };
    this.delivered = false;
    return this.inFlight;
  }

  /** 指定批次已成功进入对端 mailbox，ACK 前不得再次提交。 */
  markDelivered(batchId: number): boolean {
    if (this.inFlight?.batchId !== batchId) return false;
    this.delivered = true;
    return true;
  }

  /** 同步拒绝或 Worker 崩溃时保留当前批次并重新开放投递。 */
  markDeliveryRejected(): void {
    if (this.inFlight !== null) this.delivered = false;
  }

  /** 对端明确拒绝当前批次时按 id 重新开放投递；错误批次 id 不改变窗口。 */
  requestRedelivery(batchId: number): boolean {
    if (this.inFlight?.batchId !== batchId || !this.delivered) return false;
    this.delivered = false;
    return true;
  }

  /** 只接受当前且已投递批次的确认；迟到或重复确认不释放另一批。 */
  acknowledge(batchId: number): boolean {
    if (this.inFlight?.batchId !== batchId || !this.delivered) return false;
    this.inFlight = null;
    this.inFlightCost = 0;
    this.delivered = false;
    return true;
  }

  /** 代际失效时按原序交出全部未确认值；领域 owner 决定恢复与请求取消。 */
  takeAll(): readonly T[] {
    const values: T[] = [];
    if (this.inFlight !== null) {
      for (const value of this.inFlight.values) values.push(value);
    }
    let entry: CostedQueueValue<T> | undefined;
    while ((entry = this.queue.shift()) !== undefined) values.push(entry.value);
    this.reset();
    return values;
  }

  /** owner 生命周期结束时 O(1) 释放全部引用并恢复初始协议状态。 */
  reset(): void {
    this.queue.clear();
    this.inFlight = null;
    this.inFlightCost = 0;
    this.queuedCost = 0;
    this.delivered = false;
    this.nextBatchId = 1;
  }
}
