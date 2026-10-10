/** owner: main。入群验证的主线程侧镜像（owner 是 packages/antiRaid/verificationMirror.ts；终态执行
 * 预算与延后索引由同域的 packages/antiRaid/verificationAttempts.ts 维护）。所有写入只经
 * 这两个模块的具名函数；活动快照、延后索引与待确认墓碑两两互斥，等待落盘的延后请求与
 * 精确落盘水位线都只属于仍在活动快照里的 key（test/helpers/verificationMirrorInvariants.ts
 * 逐条断言）。
 *
 * 本模块是主线程状态，不与 cache/workers/antiRaid/verification.ts 的入群守卫线程验证状态机共享：
 * 权威状态机在 Worker 内，本模块只保存供两类 Worker 崩溃重放的纯数据。
 */

import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../../../types/antiRaid/verification";

/** activeVerificationSnapshots 的可变实例；只经下面三个写入函数修改。 */
const activeSnapshots: Map<string, VerificationSnapshot> = new Map();

/**
 * 主线程持有的待验证纯数据镜像，key 为 verificationKey(chatId, userId)，
 * 作为 Anti-Raid Worker 与 Disk I/O Worker 崩溃重放的数据源；权威状态机在 Anti-Raid Worker 内。
 * hydratePendingVerifications 在启动时先清空、再用 Disk I/O 恢复出的记录整体重建；
 * 此后 antiRaid/verificationMirror.ts 按 generation+revision 拒绝迟到事件后增量更新/删除。
 * Anti-Raid Worker 崩溃重建时（onRespawn）本镜像不清空，只原地把每条记录的 generation
 * 提升到新代际后整体回放给新 Worker；Disk I/O Worker 崩溃重建时（onDiskIORespawn）
 * 同样整体重放给它补齐。
 *
 * 容量：本层不设淘汰；硬顶由 antiRaid/verificationMirror.ts 按 VERIFICATION_RECORD_CAPACITY 拒收
 * 新记录并请求受监督重启，落盘侧 workers/diskIO/verificationWrites.ts 再核一次；延后的终态由
 * deferredVerificationRecords 以最小索引保留。
 *
 * 导出只读视图；写入只经 setActiveVerificationSnapshot、deleteActiveVerificationSnapshot 与
 * clearActiveVerificationSnapshots，三者同步维护下面的按群二级索引。
 */
export const activeVerificationSnapshots: ReadonlyMap<string, VerificationSnapshot> = activeSnapshots;

/**
 * activeVerificationSnapshots 的按群二级索引：chatId -> 该群活动镜像里的 userId 集合，供每条群消息判定
 * 「发送者是否待验证」时按数值键查表、不拼复合键（isActiveVerificationUser）。随活动镜像的三个写入函数
 * 同步填充与清理，群的集合清空时删除该群条目；Worker 崩溃不清理（主线程状态）。容量与活动镜像同阶。
 */
const activeUsersByChat: Map<number, Set<number>> = new Map();

/** 写入或替换一条活动快照，并把 snapshot 的 chatId/userId 登记进按群索引；key 为 verificationKey(chatId, userId)。 */
export function setActiveVerificationSnapshot(key: string, snapshot: VerificationSnapshot): void {
  activeSnapshots.set(key, snapshot);
  let users: Set<number> | undefined = activeUsersByChat.get(snapshot.chatId);
  if (users === undefined) {
    users = new Set();
    activeUsersByChat.set(snapshot.chatId, users);
  }
  users.add(snapshot.userId);
}

/** 删除一条活动快照及其按群索引；key 不在镜像里时不做任何事。 */
export function deleteActiveVerificationSnapshot(key: string): void {
  const snapshot: VerificationSnapshot | undefined = activeSnapshots.get(key);
  if (snapshot === undefined) return;
  activeSnapshots.delete(key);
  const users: Set<number> | undefined = activeUsersByChat.get(snapshot.chatId);
  if (users === undefined) return;
  users.delete(snapshot.userId);
  if (users.size === 0) activeUsersByChat.delete(snapshot.chatId);
}

/** 清空活动镜像与按群索引。 */
export function clearActiveVerificationSnapshots(): void {
  activeSnapshots.clear();
  activeUsersByChat.clear();
}

/** userId 在 chatId 群的活动镜像里是否有待验证快照；按数值键查按群索引，不分配对象。 */
export function isActiveVerificationUser(chatId: number, userId: number): boolean {
  if (activeUsersByChat.size === 0) return false;
  return activeUsersByChat.get(chatId)?.has(userId) === true;
}

/**
 * 主线程已收到 Disk I/O 回执的最新 active revision，用于 Anti-Raid Worker 重建。
 * 清理：对应 key 从 activeVerificationSnapshots 删除并收到删除回执时移出，
 * 完整启动 hydrate 时整表重建。容量与 activeVerificationSnapshots 同阶。
 */
export const persistedVerificationRevisions: Map<string, { generation: number; revision: number }> = new Map();

/**
 * 已从 active 镜像删除、但尚未收到当天 JSON 追加确认的终结变化。
 * 清理：收到该 revision 的追加确认时移出，完整启动 hydrate 时整表清空。
 * 容量：同时在途的终结写入数，被 Disk I/O 的写预算封住；不设淘汰。
 */
export const pendingVerificationDeletes: Map<string, {
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}> = new Map();

/**
 * 每条终态的本进程执行次数；首次许可时填充，确认延后时标记为上限，
 * 正常删除或完整启动 hydrate 时清理。跨 Anti-Raid Worker 代际保留，容量不超过
 * 当前活动验证与延后索引的 key 数；Worker 崩溃无需重放，主线程继续作为权威。
 */
export const terminalVerificationAttempts: Map<string, number> = new Map();

/**
 * 预算耗尽或许可无法确认后从活动镜像移出的最小索引；Worker 上报精确
 * generation/revision 时填充，明确离群、功能关闭或群 teardown 时写 tombstone 后
 * 清理。完整进程重启不恢复本索引，磁盘快照会重新进入活动镜像；容量不超过仍留在
 * 磁盘且本进程已延后的终态数。Anti-Raid Worker 重建时全量重放给新 isolate，
 * 缺少条目表示本进程没有已知的延后闩锁，不得解释为沿用旧值。
 */
export const deferredVerificationRecords: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * Worker 已卸载运行态、但最后 revision 尚未收到落盘回执的延后
 * 请求；期间完整快照继续留在 activeVerificationSnapshots，供 DiskIO 重建重放，
 * Anti-Raid Worker adopt 则只接管本最小闩锁。精确落盘回执后移入正式延后索引，
 * 显式删除或完整启动时清理。容量不超过在途关键验证写入数。
 */
export const pendingVerificationDeferrals: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * 验证记录容量首次越界后置位，确保同一停机链只向应用生命周期
 * 报告一次 fatal；完整启动 hydrate 与 terminate 重置。容量恒为一个 boolean，
 * Worker 崩溃不清理。
 */
export const verificationCapacityFatalState: { current: boolean } = {
  current: false,
};
