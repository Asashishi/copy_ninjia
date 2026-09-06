/** Owner: Disk I/O Worker。异步内容 I/O 与消息处理的唯一串行边界。 */

import { diskIOOperationCount, diskIOOperationTail } from "../../cache/workers/diskIO/recovery";
import { DISK_WORKER_MAX_QUEUED_OPERATIONS } from "../../consts/diskIO/business";

/** 一项 Disk I/O 操作；同步维护任务与异步内容读取共用同一签名。 */
export type DiskIOOperation = () => void | Promise<void>;

/**
 * 把操作追加到当前尾节点。前一项拒绝后不再运行后续项，交由 Worker 的未捕获
 * rejection 终止本代；主线程 supervisor 会创建全新 isolate 并重新执行 load。
 */
export function enqueueDiskIOOperation(
  operation: DiskIOOperation
): Promise<void> {
  if (diskIOOperationCount.current >= DISK_WORKER_MAX_QUEUED_OPERATIONS) {
    return Promise.reject(new Error("Disk I/O Worker operation capacity was exhausted."));
  }
  diskIOOperationCount.current++;
  const next: Promise<void> = diskIOOperationTail.current.then(operation).finally((): void => {
    diskIOOperationCount.current--;
  });
  diskIOOperationTail.current = next;
  return next;
}
