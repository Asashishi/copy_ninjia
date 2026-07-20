import type { VerificationSnapshot } from "../types/antiRaid";

export interface PersistedLockdownFingerprint {
  phase: "applying" | "active" | "restoring";
  intentId: number;
  expiresAt: number;
}

/** Anti-Raid 主线程代理的代际与初始化状态。 */
export const antiRaidRuntimeState: { generation: number; initialized: boolean } = {
  generation: 0,
  initialized: false,
};

/** 主线程镜像可能仍在 fsync；Worker 重建时不能把它自动视为已经持久化。 */
export const persistedLockdownFingerprints: Map<number, PersistedLockdownFingerprint> = new Map();
/** 每群至多保留一个 durability waiter；期间的新阶段由完成后的循环补写。 */
export const pendingLockdownPersistence: Set<number> = new Set();

/** 主线程持有的待验证最新纯数据镜像，供两类 Worker 重建时重放。 */
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
