import { diskIORuntime } from "../../cache/main/diskIO";
import { DISK_OPERATION_MAX_RETAINED_BYTES, DISK_BUSINESS_ACK_TIMEOUT_MS, DISK_BUSINESS_MAX_RETAINED_BYTES, DISK_OPERATION_CONTROL_RESERVE } from "../../consts/diskIO/business";
import { diskIOMessageCost, isDiskBusinessMessage } from "../../libs/diskIOMessageCost";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { AcknowledgedBatch } from "../../libs/acknowledgedBatchQueue";
import type { DiskBusinessMessage, DiskIOMessage, DiskIOOperationMessage } from "../../types/diskIO/messages";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { signalDiskIOFatal } from "./fatal";

/**
 * Worker.postMessage 可能在本地 owner 仍判定 Worker 可写之后同步抛出；把这个
 * 竞态统一挡在这里，不让它扩散到每一个业务、诊断与请求类调用方。
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

/** 状态发布前检查业务传输与恢复 FIFO 的合计容量；不改变任一队列。 */
export function canQueueDiskIOBusiness(message: DiskBusinessMessage): boolean {
  if (diskIORuntime.fatalSignaled) return false;
  const cost: number = diskIOMessageCost(message);
  const fits: boolean = diskIORuntime.operationQueue.size + diskIORuntime.pendingBusinessMessages.size < diskIORuntime.maxPendingBusinessMessages &&
    cost <= DISK_BUSINESS_MAX_RETAINED_BYTES - diskIORuntime.operationQueue.retainedCost - diskIORuntime.pendingBusinessBytes;
  if (!fits) signalDiskIOFatal(new Error("Disk I/O business queue capacity was exhausted."));
  return fits;
}

function pumpDiskIOOperations(worker: Worker): boolean {
  if (diskIORuntime.worker !== worker) return false;
  const batch: AcknowledgedBatch<DiskIOOperationMessage> | null = diskIORuntime.operationQueue.nextDelivery();
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
  if (diskIORuntime.worker !== worker) return false;
  const cost: number = diskIOMessageCost(message);
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
  const retained: readonly DiskIOOperationMessage[] = diskIORuntime.operationQueue.takeAll();
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

/** 宿主最终终止时释放传输引用与 timer；不参与运行时恢复的事实淘汰。 */
export function resetDiskIOOperations(): void {
  clearOperationTimer();
  diskIORuntime.operationQueue.reset();
  diskIORuntime.pendingBusinessBytes = 0;
}
