import type { VerificationSnapshot } from "../../../types/antiRaid";

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
