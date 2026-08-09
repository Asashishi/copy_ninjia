import { LinkedQueue } from "./linkedQueue";

/** 从队列取出的唯一在途批次；对端 ACK 前由生产方保留以支持代际重发。 */
export interface AcknowledgedBatch<T> {
  readonly batchId: number;
  readonly values: readonly T[];
}

/**
 * 单向通道的 ACK 批处理队列。
 *
 * 队列只允许一个批次在途，避免对端停止消费时继续向 Worker mailbox 无界复制；
 * 在途值保留到 ACK，投递拒绝或对端代际崩溃后可原批重发，语义为 at-least-once。
 * 待发送队列是否设容量属于领域决策；本实现不擅自丢弃。实例必须放进所属线程的
 * cache 模块。
 */
export class AcknowledgedBatchQueue<T> {
  private readonly queue: LinkedQueue<T> = new LinkedQueue<T>();
  private readonly maxBatchMessages: number;
  private inFlight: AcknowledgedBatch<T> | null = null;
  private delivered: boolean = false;
  private nextBatchId: number = 1;

  constructor(maxBatchMessages: number) {
    if (!Number.isSafeInteger(maxBatchMessages) || maxBatchMessages <= 0) {
      throw new RangeError("maxBatchMessages must be a positive safe integer");
    }
    this.maxBatchMessages = maxBatchMessages;
  }

  /** 当前排队与在途消息总数。 */
  get size(): number {
    return this.queue.size + (this.inFlight?.values.length ?? 0);
  }

  /** 是否有一批已经成功提交给对端、正在等待确认。 */
  get awaitingAcknowledgement(): boolean {
    return this.inFlight !== null && this.delivered;
  }

  /** 追加到无损 FIFO；领域 owner 决定容量策略。 */
  enqueue(value: T): void {
    this.queue.push(value);
  }

  /**
   * 返回下一批需要投递的值。同步拒绝或代际崩溃后返回同一批；成功提交且尚未
   * ACK 时返回 null，保证 mailbox 里最多只有一个诊断批次。
   */
  nextDelivery(): AcknowledgedBatch<T> | null {
    if (this.inFlight !== null) return this.delivered ? null : this.inFlight;
    if (this.queue.size === 0) return null;
    const values: T[] = [];
    while (values.length < this.maxBatchMessages) {
      const value: T | undefined = this.queue.shift();
      if (value === undefined) break;
      values.push(value);
    }
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
    this.delivered = false;
    return true;
  }

  /** owner 生命周期结束时 O(1) 释放全部引用并恢复初始协议状态。 */
  reset(): void {
    this.queue.clear();
    this.inFlight = null;
    this.delivered = false;
    this.nextBatchId = 1;
  }
}
