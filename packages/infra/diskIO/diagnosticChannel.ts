import { diskIORuntime } from "../../cache/main/diskIO";
import type {
  DiskDiagnosticBatchRequest,
  DiskDiagnosticMessage,
} from "../../types/diskIO";
import type { FlushResult } from "../../types/lifecycle";
import type { AcknowledgedBatch } from "../../libs/acknowledgedBatchQueue";
import { jsonSerializedBytes } from "../../libs/jsonBytes";
import { saturatingSafeIntegerAdd } from "../../libs/saturatingNumber";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { safePostDiskIO } from "./transport";

function recordDroppedDiskIODiagnostic(serializedBytes: number): void {
  if (diskIORuntime.diagnosticDroppedMessages === 0) {
    writeDiskIODiagnostic(
      "[diskIO] diagnostic queue capacity reached; dropping diagnostics until the durable FIFO drains."
    );
  }
  diskIORuntime.diagnosticDroppedMessages = saturatingSafeIntegerAdd(
    diskIORuntime.diagnosticDroppedMessages,
    1
  );
  diskIORuntime.diagnosticDroppedSerializedBytes = saturatingSafeIntegerAdd(
    diskIORuntime.diagnosticDroppedSerializedBytes,
    serializedBytes
  );
}

/** 有空间后把整段溢出收敛成一条普通 error 日志，保持 FIFO 与 durable ACK。 */
function enqueueDiskIODiagnosticDropSummary(): void {
  const droppedMessages: number = diskIORuntime.diagnosticDroppedMessages;
  if (droppedMessages === 0) return;
  const droppedBytes: number = diskIORuntime.diagnosticDroppedSerializedBytes;
  const summary: DiskDiagnosticMessage = {
    type: "log",
    timestamp: Date.now(),
    level: "error",
    args: [
      `[diskIO] dropped ${droppedMessages} diagnostic message(s) totaling ` +
      `${droppedBytes} serialized byte(s) after the in-process queue reached its hard limits.`,
    ],
  };
  if (!diskIORuntime.diagnosticQueue.enqueue(
    summary,
    jsonSerializedBytes(summary)
  )) return;
  diskIORuntime.diagnosticDroppedMessages = 0;
  diskIORuntime.diagnosticDroppedSerializedBytes = 0;
}

/** 清理诊断重投 timer；代际切换和 terminate 都复用。 */
function clearDiskDiagnosticRetryTimer(): void {
  if (diskIORuntime.diagnosticRetryTimer === null) return;
  clearTimeout(diskIORuntime.diagnosticRetryTimer);
  diskIORuntime.diagnosticRetryTimer = null;
}

/** 结算等待诊断 FIFO 清空的全局 flush；领域级 flush 不登记到这里。 */
function settleDiskDiagnosticDrainWaiters(result: FlushResult): void {
  for (const waiter of diskIORuntime.diagnosticDrainWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }
  diskIORuntime.diagnosticDrainWaiters.clear();
}

/** 在不阻止进程退出的 timer 后重投当前原批；只允许一个重试 timer。 */
function scheduleDiskDiagnosticRetry(worker: Worker, retryAfterMs: number): void {
  clearDiskDiagnosticRetryTimer();
  diskIORuntime.diagnosticRetryTimer = setTimeout((): void => {
    diskIORuntime.diagnosticRetryTimer = null;
    pumpDiskIODiagnostics(worker);
  }, retryAfterMs);
  diskIORuntime.diagnosticRetryTimer.unref();
}

/** 把下一批诊断交给指定代际；同一时刻最多存在一个尚未确认的批次。 */
function pumpDiskIODiagnostics(worker: Worker): boolean {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return false;
  // Worker 已明确要求按文件重开窗口退避时，新日志只能继续进本地 FIFO，不能
  // 借每次 enqueue 绕过 timer 反复重读损坏/只读的整份日志文件。
  if (diskIORuntime.diagnosticRetryTimer !== null) return true;
  const batch: AcknowledgedBatch<DiskDiagnosticMessage> | null =
    diskIORuntime.diagnosticQueue.nextDelivery();
  if (batch === null) return true;
  const request: DiskDiagnosticBatchRequest = {
    type: "diagnosticBatch",
    batchId: batch.batchId,
    messages: batch.values,
  };
  if (safePostDiskIO(worker, request, "diagnostic batch")) {
    diskIORuntime.diagnosticQueue.markDelivered(batch.batchId);
    return true;
  }
  diskIORuntime.diagnosticQueue.markDeliveryRejected();
  return false;
}

/**
 * 把诊断收入主线程有界 FIFO。DiskIO 尚未可写时仍保留；单批 ACK 窗口避免把
 * 积压复制进 Worker mailbox。越界消息释放引用并合并为后续一条汇总日志。
 */
export function enqueueDiskIODiagnostic(message: DiskDiagnosticMessage): boolean {
  enqueueDiskIODiagnosticDropSummary();
  const serializedBytes: number = jsonSerializedBytes(message);
  if (!diskIORuntime.diagnosticQueue.enqueue(message, serializedBytes)) {
    recordDroppedDiskIODiagnostic(serializedBytes);
  }
  const worker: Worker | null = diskIORuntime.worker;
  if (worker !== null && diskIORuntime.writable) pumpDiskIODiagnostics(worker);
  // true 表示已经由本边界接管：消息要么在 FIFO，要么已进入有界丢弃记账。
  // Worker 日志转发据此 ACK 原批，避免把积压转移回业务 isolate。
  return true;
}

/** 当前 DiskIO 代际确认一批诊断后推进发送窗口；迟到 ACK 不影响新代际。 */
export function acceptDiskIODiagnosticBatch(worker: Worker, batchId: number): boolean {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return false;
  if (!diskIORuntime.diagnosticQueue.acknowledge(batchId)) return false;
  enqueueDiskIODiagnosticDropSummary();
  pumpDiskIODiagnostics(worker);
  if (diskIORuntime.diagnosticQueue.size === 0) {
    settleDiskDiagnosticDrainWaiters("flushed");
  }
  return true;
}

/**
 * 等待当前全部诊断获得 durable ACK。只供进程级 flush 使用；新诊断在调用方真正
 * 发出 flush 请求前还会再次检查，封住 Promise 续体之间的入队竞态。
 */
export function waitForDiskIODiagnostics(timeoutMs: number): Promise<FlushResult> {
  enqueueDiskIODiagnosticDropSummary();
  const worker: Worker | null = diskIORuntime.worker;
  if (worker !== null && diskIORuntime.writable) pumpDiskIODiagnostics(worker);
  if (diskIORuntime.diagnosticQueue.size === 0) return Promise.resolve("flushed");
  if (worker === null) return Promise.resolve("failed");
  return new Promise<FlushResult>((resolve: (result: FlushResult) => void): void => {
    const waiter: {
      resolve: (result: FlushResult) => void;
      timer: ReturnType<typeof setTimeout>;
    } = {
      resolve,
      timer: setTimeout((): void => {
        diskIORuntime.diagnosticDrainWaiters.delete(waiter);
        resolve("timedOut");
      }, timeoutMs),
    };
    diskIORuntime.diagnosticDrainWaiters.add(waiter);
  });
}

export interface RetryDiskIODiagnosticBatchOptions {
  worker: Worker;
  batchId: number;
  retryAfterMs: number;
  schedule: boolean;
}

/**
 * Worker 明确表示日志刷盘失败时重新开放原批；普通失败按退避窗口重发，达到宿主
 * 连续失败阈值时只开放、不再给即将被替换的旧代际安排 timer。
 */
export function retryDiskIODiagnosticBatch({
  worker,
  batchId,
  retryAfterMs,
  schedule,
}: RetryDiskIODiagnosticBatchOptions): boolean {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return false;
  if (!diskIORuntime.diagnosticQueue.requestRedelivery(batchId)) return false;
  if (schedule) scheduleDiskDiagnosticRetry(worker, retryAfterMs);
  return true;
}

/** 新 DiskIO 代际完成恢复后重发未确认批次并继续排空 FIFO。 */
export function resumeDiskIODiagnosticChannel(worker: Worker): void {
  if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return;
  pumpDiskIODiagnostics(worker);
}

/** DiskIO 代际失效时把未确认批次标为待重发，不释放其中的诊断。 */
export function pauseDiskIODiagnosticChannel(): void {
  clearDiskDiagnosticRetryTimer();
  diskIORuntime.diagnosticQueue.markDeliveryRejected();
}

/** 整个宿主 terminate 后不再存在可恢复代际，此时释放全部进程内诊断引用。 */
export function resetDiskIODiagnosticChannel(): void {
  clearDiskDiagnosticRetryTimer();
  settleDiskDiagnosticDrainWaiters("failed");
  diskIORuntime.diagnosticQueue.reset();
  diskIORuntime.diagnosticDroppedMessages = 0;
  diskIORuntime.diagnosticDroppedSerializedBytes = 0;
}
