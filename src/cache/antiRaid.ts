import type { ChatPermissions } from "@grammyjs/types";
import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "../consts/antiRaid/protocol";
import { createFlushBarrier } from "../libs/flushBarrier";
import type { VerificationSnapshot } from "../types/antiRaid";

/**
 * Anti-Raid 主线程与 Worker 的 mailbox barrier。模块加载时创建，terminate
 * 时统一结算等待者；进程重启后以空等待表和新序号重建，容量受并发 flush 数约束。
 */
export const antiRaidBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS,
});

/** 主线程判断 lockdown 落盘回执是否仍对应当前意图的指纹。 */
export interface PersistedLockdownFingerprint {
  phase: "applying" | "active" | "restoring";
  intentId: number;
  expiresAt: number;
}

/** Anti-Raid 主线程代理的代际与初始化状态。 */
export const antiRaidRuntimeState: { generation: number; initialized: boolean; persistenceVersion: number } = {
  generation: 0,
  initialized: false,
  persistenceVersion: 0,
};

/** 主线程镜像可能仍在 fsync；Worker 重建时不能把它自动视为已经持久化。 */
export const persistedLockdownFingerprints: Map<number, PersistedLockdownFingerprint> = new Map();
/** 每群至多保留一个 durability waiter；期间的新阶段由完成后的循环补写。 */
export const pendingLockdownPersistence: Set<number> = new Set();

/** Worker 永久不可用后，单群主线程权限恢复链的运行态。 */
export interface EmergencyLockdownRecovery {
  fingerprint: PersistedLockdownFingerprint;
  originalPermissions: ChatPermissions;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

/** Worker 放弃自愈后，主线程每群至多持有一条权限恢复链。 */
export const emergencyLockdownRecoveries: Map<number, EmergencyLockdownRecovery> = new Map();
/** terminate 关闸后，迟到 API 结果不得修改 state 或重新挂 timer。 */
export const emergencyLockdownRecoveryRuntime: { stopped: boolean } = { stopped: true };

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
