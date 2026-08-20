import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../../../types/antiRaid/verification";

/**
 * 入群验证的主线程侧镜像（owner 是 packages/antiRaid/verificationMirror.ts）。
 *
 * 这里全是**主线程**状态，与 cache/workers/antiRaid/verification.ts 那份入群守卫线程
 * 的验证状态机没有任何共享：权威状态机在 Worker 内，本模块只保存供两类 Worker
 * 崩溃重放的纯数据。
 */

/**
 * 主线程持有的待验证纯数据镜像，key 为 verificationKey(chatId, userId)；
 * 不是验证状态机本身——权威状态在 Anti-Raid Worker 内，这里只做两类 Worker
 * 崩溃重放的数据源。hydratePendingVerifications 在启动时先清空、再用 Disk
 * I/O 恢复出的记录整体重建；此后 antiRaid/verificationMirror.ts 按
 * generation+revision 拒绝迟到事件后增量更新/删除。Anti-Raid Worker
 * 崩溃重建时（onRespawn）本镜像不清空，只原地把
 * 每条记录的 generation 提升到新代际后整体回放给新 Worker；Disk I/O Worker
 * 崩溃重建时（onDiskIORespawn）同样整体重放给它补齐。
 */
export const activeVerificationSnapshots: Map<string, VerificationSnapshot> = new Map();

/** 主线程已收到 Disk I/O 回执的最新 active revision，用于 Anti-Raid Worker 重建。 */
export const persistedVerificationRevisions: Map<string, { generation: number; revision: number }> = new Map();

/** 已从 active 镜像删除、但尚未收到当天 JSON 追加确认的终结变化。 */
export const pendingVerificationDeletes: Map<string, {
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}> = new Map();

/**
 * owner：主线程。每条验证终态在本进程已批准的执行次数；首次终态许可时填充，
 * 正常删除或完整启动 hydrate 时清理。跨 Anti-Raid Worker 代际保留，容量不超过
 * 当前活动验证与延后索引的 key 数；Worker 崩溃无需重放，主线程继续作为权威。
 */
export const terminalVerificationAttempts: Map<string, number> = new Map();

/**
 * owner：主线程。预算耗尽后从活动镜像移出的最小索引；Worker 上报精确
 * generation/revision 时填充，明确离群、功能关闭或群 teardown 时写 tombstone 后
 * 清理。完整进程重启不恢复本索引，磁盘快照会重新进入活动镜像；容量不超过仍留在
 * 磁盘且本进程已耗尽预算的终态数。Anti-Raid Worker 重建时全量重放给新 isolate，
 * 缺少条目表示本进程没有已知的延后闩锁，不得解释为沿用旧值。
 */
export const deferredVerificationRecords: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * owner：主线程。Worker 已卸载运行态、但最后 revision 尚未收到落盘回执的延后
 * 请求；期间完整快照继续留在 activeVerificationSnapshots，供 DiskIO 重建重放，
 * Anti-Raid Worker adopt 则只接管本最小闩锁。精确落盘回执后移入正式延后索引，
 * 显式删除或完整启动时清理。容量不超过在途关键验证写入数。
 */
export const pendingVerificationDeferrals: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * owner：主线程。验证记录容量首次越界后置位，确保同一停机链只向应用生命周期
 * 报告一次 fatal；完整启动 hydrate 与 terminate 重置。容量恒为一个 boolean，
 * Worker 崩溃不清理，因为换 isolate 不能解除进程级容量越界。
 */
export const verificationCapacityFatalState: { current: boolean } = {
  current: false,
};
