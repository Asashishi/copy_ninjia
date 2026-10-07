/** owner: workers/diskIO。主线程恢复重放与操作队列（packages/workers/diskIOWorker.ts）的进程内状态。 */

/**
 * 当前是否正处在主线程恢复缓冲的重放区间内。
 *
 * 由主线程 activateDiskIOWorker 在重放前后各发一条 `recoveryReplay` 标记开合
 * （见 types/diskIO/messages.ts 的 RecoveryReplayRequest）。填充时机 = 收到 active:true；
 * 清理时机 = 收到 active:false，或本 Worker 因崩溃被替换，新 Worker 从 false
 * 起步，新一轮重放重新发 active:true。
 *
 * 区间内被拒收的写入回报 recoveryReplayFailed（升级为 fatal），区间外按在线写失败处理；
 * 只有显式 active:false 与新实例初值清零，不设超时自动复位。
 */
export const diskIOReplayWindow: { current: boolean } = { current: false };

/**
 * Disk I/O Worker 的异步操作尾节点。启动 load、业务消息与合并后的定时操作（见
 * workers/diskIO/timedFlush.ts）都追加到同一条 Promise 链；每次只保留尚未结算的尾节点，结算后不保留历史消息。
 * Worker 重建会重新加载本 isolate，初值恢复为已结算 Promise。
 */
export const diskIOOperationTail: { current: Promise<void> } = {
  current: Promise.resolve(),
};

/** 入队自增、结算递减，上限见 DISK_WORKER_MAX_QUEUED_OPERATIONS；isolate 重建从零开始。 */
export const diskIOOperationCount: { current: number } = { current: 0 };
