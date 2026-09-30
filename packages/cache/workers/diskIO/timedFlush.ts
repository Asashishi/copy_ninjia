/** owner：Disk I/O Worker（packages/workers/diskIO/timedFlush.ts）。 */

import type { TimedDiskIOOperation } from "../../../types/diskIO/storage";

/**
 * 已到点、等待合并执行的定时操作。
 *
 * - 填充：领域 flush timer 到点时加入；同一函数只占一项。
 * - 清理：合并操作按加入顺序逐项取出后执行。
 * - 容量：以定时来源的种类数为上界（AI 用量、运势、入群日志、广告样本、验证合并与验证
 *   轮换重试），各来源的 timer 槽位保证同一来源不重复排队。
 * - 重建：Worker 重建时随 isolate 清空；未执行的定时 flush 由各领域下一次写入重新装
 *   timer 或统一 flush 兑现。
 */
export const dueTimedDiskIOOperations: Set<TimedDiskIOOperation> = new Set();

/**
 * 合并操作是否已排进统一操作队列且尚未执行完毕：排入时置 true，执行结束（含拒绝）时置
 * false。Worker 重建时从 false 起步；true 期间新到点的操作只加入
 * dueTimedDiskIOOperations，由那一项合并操作一并执行。
 */
export const timedDiskIOOperationState: { queued: boolean } = { queued: false };
