/**
 * Owner: Disk I/O Worker。领域定时 flush 的统一 timer 与合并入队边界。
 *
 * 各领域到点的定时 flush 经 queueTimedDiskIOOperation 合并为统一操作队列里的至多一项，
 * 定时来源的种类再多也只占一个队列位置（容量口径见 consts/diskIO/business.ts 的
 * DISK_WORKER_MAX_QUEUED_OPERATIONS）。flush 写出的是执行那一刻的缓冲，与它在队列里的
 * 位置无关；对顺序敏感的每日维护不走这里，由 maintenanceCron.ts 直接入队。
 */

import {
  dueTimedDiskIOOperations,
  timedDiskIOOperationState,
} from "../../cache/workers/diskIO/timedFlush";
import { enqueueDiskIOOperation } from "./operationQueue";
import type { FlushTimerSlot, TimedDiskIOOperation } from "../../types/diskIO/storage";

/**
 * 按加入顺序执行已到点的定时操作；执行期间新到点的操作排在本轮末尾一并执行。
 * 任一操作拒绝时本项随之拒绝，统一操作队列据此终止本代 Worker。
 */
async function runDueTimedDiskIOOperations(): Promise<void> {
  try {
    for (const operation of dueTimedDiskIOOperations) {
      dueTimedDiskIOOperations.delete(operation);
      await operation();
    }
  } finally {
    timedDiskIOOperationState.queued = false;
  }
}

/** 登记一项到点的定时操作；合并操作尚未排队时排进统一操作队列。 */
export function queueTimedDiskIOOperation(operation: TimedDiskIOOperation): void {
  dueTimedDiskIOOperations.add(operation);
  if (timedDiskIOOperationState.queued) return;
  timedDiskIOOperationState.queued = true;
  void enqueueDiskIOOperation(runDueTimedDiskIOOperations);
}

/**
 * 槽位空闲时装一次 delayMs 后触发的 timer，已装时不重复装。触发时先清空槽位再登记
 * operation，此后到达的写入可以重新装 timer。timer unref，不扣住 Worker 事件循环。
 */
export function armDiskIOFlushTimer(
  slot: FlushTimerSlot,
  delayMs: number,
  operation: TimedDiskIOOperation
): void {
  if (slot.timer !== null) return;
  slot.timer = setTimeout((): void => {
    slot.timer = null;
    queueTimedDiskIOOperation(operation);
  }, delayMs);
  slot.timer.unref();
}

/** 取消槽位上尚未触发的 timer；直接 flush 前调用，槽位空闲时幂等。 */
export function cancelDiskIOFlushTimer(slot: FlushTimerSlot): void {
  if (slot.timer === null) return;
  clearTimeout(slot.timer);
  slot.timer = null;
}
