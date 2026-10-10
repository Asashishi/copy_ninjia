import { diskIOFlushBarrier, diskIORuntime, pendingFlushFailedDomains } from "../../cache/main/diskIO";
import { DISK_OPERATION_MAX_RETAINED_BYTES, DISK_BUSINESS_ACK_TIMEOUT_MS, DISK_BUSINESS_MAX_RETAINED_BYTES, DISK_OPERATION_CONTROL_RESERVE } from "../../consts/diskIO/business";
import { diskIOMessageCost, isDiskBusinessMessage } from "../../libs/diskIOMessageCost";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { AcknowledgedBatch } from "../../libs/acknowledgedBatchQueue";
import type {
  DiskBusinessMessage,
  DiskFlushRequest,
  DiskFlushScope,
  DiskIOMessage,
  DiskIOOperationMessage,
  QueuedDiskIOOperationMessage,
} from "../../types/diskIO/messages";
import type { DiskIODomain, DomainFlushOutcome } from "../../types/diskIO/replies";
import type { FlushResult } from "../../types/lifecycle";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { signalDiskIOFatal } from "./fatal";

/**
 * Worker.postMessage 可能在本地 owner 仍判定 Worker 可写时同步抛出；这里统一捕获，
 * 以返回值表示是否被接受。
 * @returns 投递是否被 Worker 接受。
 */
function postRaw(worker: Worker, message: DiskIOMessage, context: string): boolean {
  try {
    worker.postMessage(message);
    return true;
  } catch (error: unknown) {
    writeDiskIODiagnostic(`[diskIO] persistence Worker rejected ${context}:`, error);
    return false;
  }
}

function clearOperationTimer(): void {
  if (diskIORuntime.operationTimer !== null) clearTimeout(diskIORuntime.operationTimer);
  diskIORuntime.operationTimer = null;
}

/**
 * 按已算好的载荷成本（libs/diskIOMessageCost.ts）检查业务传输与恢复 FIFO 的合计容量；
 * 不改变任一队列，容量耗尽时通知 fatal。
 */
export function fitsDiskIOBusiness(cost: number): boolean {
  if (diskIORuntime.fatalSignaled) return false;
  const fits: boolean = diskIORuntime.operationQueue.size + diskIORuntime.pendingBusinessMessages.size < diskIORuntime.maxPendingBusinessMessages &&
    cost <= DISK_BUSINESS_MAX_RETAINED_BYTES - diskIORuntime.operationQueue.retainedCost - diskIORuntime.pendingBusinessBytes;
  if (!fits) signalDiskIOFatal(new Error("Disk I/O business queue capacity was exhausted."));
  return fits;
}

/** 状态发布前检查业务传输与恢复 FIFO 的合计容量；不改变任一队列。 */
export function canQueueDiskIOBusiness(message: DiskBusinessMessage): boolean {
  return fitsDiskIOBusiness(diskIOMessageCost(message));
}

function pumpDiskIOOperations(worker: Worker): boolean {
  if (diskIORuntime.worker !== worker) return false;
  const batch: AcknowledgedBatch<QueuedDiskIOOperationMessage> | null = diskIORuntime.operationQueue.nextDelivery();
  if (batch === null) return true;
  diskIORuntime.operationQueue.markDelivered(batch.batchId);
  diskIORuntime.operationTimer = setTimeout((): void => {
    diskIORuntime.operationTimer = null;
    if (diskIORuntime.worker === worker) signalDiskIOFatal(new Error("Disk I/O operation batch acknowledgement timed out."));
  }, DISK_BUSINESS_ACK_TIMEOUT_MS);
  diskIORuntime.operationTimer.unref();
  if (postRaw(worker, { type: "operationBatch", batchId: batch.batchId, messages: batch.values }, "operation batch")) return true;
  clearOperationTimer();
  if (batch.values.some(isDiskBusinessMessage)) diskIORuntime.operationQueue.markDeliveryRejected();
  else diskIORuntime.operationQueue.acknowledge(batch.batchId);
  return false;
}

/** 启动与诊断各自拥有有界握手；其余操作共用 FIFO，读取与 flush 不越过写入。 */
export function safePostDiskIO(worker: Worker, message: DiskIOOperationMessage, context: string): boolean {
  if (message.type === "load" || message.type === "diagnosticBatch") return postRaw(worker, message, context);
  return queueDiskIOOperationMessage(worker, message, diskIOMessageCost(message));
}

/**
 * 经 diskIOFlushBarrier 向 worker 发一次 scope 范围的 flush 并等回执；不核对可写状态，由调用方决定能否发起。
 * failedDomains 为本次回执里的失败领域名，取出后从 pendingFlushFailedDomains 移除；超时或 Worker 崩溃中途结算时
 * 没有本次回执，为 undefined。
 */
export async function beginDiskIOFlush(
  worker: Worker,
  scope: DiskFlushScope,
  timeoutMs: number
): Promise<DomainFlushOutcome> {
  let flushId: number | null = null;
  const result: FlushResult = await diskIOFlushBarrier.begin((id: number): boolean => {
    flushId = id;
    const request: DiskFlushRequest = { type: "flush", flushId: id, scope };
    return safePostDiskIO(worker, request, `${scope} flush request`);
  }, timeoutMs);
  if (flushId === null) return { result };
  const failedDomains: readonly DiskIODomain[] | undefined = pendingFlushFailedDomains.get(flushId);
  pendingFlushFailedDomains.delete(flushId);
  return failedDomains === undefined ? { result } : { result, failedDomains };
}

/**
 * 按已算好的成本把一条操作排进共用 FIFO 并尝试投递；超出条数或字节上限时通知 fatal。
 * 启动 load 与诊断批次不经这里，见 safePostDiskIO。
 */
export function queueDiskIOOperationMessage(worker: Worker, message: QueuedDiskIOOperationMessage, cost: number): boolean {
  if (diskIORuntime.worker !== worker) return false;
  if (diskIORuntime.operationQueue.size + diskIORuntime.pendingBusinessMessages.size >=
      diskIORuntime.maxPendingBusinessMessages + DISK_OPERATION_CONTROL_RESERVE ||
    cost > DISK_OPERATION_MAX_RETAINED_BYTES - diskIORuntime.operationQueue.retainedCost - diskIORuntime.pendingBusinessBytes ||
    !diskIORuntime.operationQueue.enqueue(message, cost)) {
    signalDiskIOFatal(new Error("Disk I/O operation queue capacity was exhausted."));
    return false;
  }
  return pumpDiskIOOperations(worker);
}

/** 恢复 FIFO 的队首原子转入发送队列；拒收仍由原 owner 保留，不重复计费或重放。 */
export function postBufferedDiskIOBusiness(worker: Worker): boolean {
  const message: DiskBusinessMessage | undefined = diskIORuntime.pendingBusinessMessages.peek();
  if (message === undefined || diskIORuntime.worker !== worker) return false;
  const cost: number = diskIOMessageCost(message);
  if (!diskIORuntime.operationQueue.enqueue(message, cost)) return false;
  diskIORuntime.pendingBusinessMessages.shift();
  diskIORuntime.pendingBusinessBytes -= cost;
  return pumpDiskIOOperations(worker);
}

/** 消费 ACK 仅释放传输预算；业务落盘仍由各领域的 revision ACK 确认。 */
export function acceptDiskIOOperationBatch(worker: Worker, batchId: number): void {
  if (diskIORuntime.worker !== worker || !diskIORuntime.operationQueue.acknowledge(batchId)) return;
  clearOperationTimer();
  if (!pumpDiskIOOperations(worker)) signalDiskIOFatal(new Error("Disk I/O Worker rejected a queued operation batch."));
}

/** 代际失效时按序收回未确认业务；读取请求不重放，宿主会拒绝其等待者。 */
export function pauseDiskIOOperations(): void {
  clearOperationTimer();
  const retained: readonly QueuedDiskIOOperationMessage[] = diskIORuntime.operationQueue.takeAll();
  const previous: LinkedQueue<DiskBusinessMessage> = diskIORuntime.pendingBusinessMessages;
  const pending: LinkedQueue<DiskBusinessMessage> = new LinkedQueue();
  let bytes: number = 0;
  for (const message of retained) {
    if (!isDiskBusinessMessage(message)) continue;
    pending.push(message);
    bytes += diskIOMessageCost(message);
  }
  let message: DiskBusinessMessage | undefined;
  while ((message = previous.shift()) !== undefined) {
    pending.push(message);
    bytes += diskIOMessageCost(message);
  }
  diskIORuntime.pendingBusinessMessages = pending;
  diskIORuntime.pendingBusinessBytes = bytes;
}

/** 宿主最终终止时释放传输引用与 timer。 */
export function resetDiskIOOperations(): void {
  clearOperationTimer();
  diskIORuntime.operationQueue.reset();
  diskIORuntime.pendingBusinessBytes = 0;
}
