import type { ChatPermissions } from "@grammyjs/types";
import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "../consts/antiRaid/protocol";
import { createFlushBarrier } from "../libs/flushBarrier";
import type { VerificationSnapshot } from "../types/antiRaid";

/** Anti-Raid 主线程侧代理（packages/antiRaid/index.ts）的内存状态。 */

/**
 * Anti-Raid 主线程与 Worker 的 mailbox barrier。模块加载时创建，terminate
 * 时统一结算等待者；进程重启后以空等待表和新序号重建，容量受并发 flush 数约束。
 */
export const antiRaidBarrier: ReturnType<typeof createFlushBarrier> = createFlushBarrier({
  timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS,
});

/**
 * 主线程判断 lockdown 落盘回执是否仍对应当前意图的指纹。
 *
 * 只由 `phase` + `intentId` 组成——它们才是一次锁定意图的身份。刻意**不含**
 * `expiresAt`：私密模式生效期间，每一条越过阈值的入群都会让 Worker 重发一次
 * `lockdown` 事件，而那条事件的 `expiresAt` 是当场 `Date.now() + LOCKDOWN_MS`
 * 算出来的，每次都不一样（见 workers/antiRaid/lockdownRuntime.ts 的
 * publishLockdownState）。把它算进指纹，antiRaid/index.ts 的对账循环就永远等不到
 * 一次「存下去的还是当前这份」——每轮一次带 fsync 的 state.json + .bak 整文件
 * 重写，入群比这两次写更快时循环不终止，既写不下指纹也发不出 lockdownPersisted。
 * 倒计时本身照常落在 ChatState.lockdown.expiresAt 里，adopt 时按它换算剩余时长。
 */
export interface PersistedLockdownFingerprint {
  phase: "applying" | "active" | "restoring";
  intentId: number;
}

/** Anti-Raid 主线程代理的代际与初始化状态。 */
export const antiRaidRuntimeState: { generation: number; initialized: boolean; persistenceVersion: number } = {
  generation: 0,
  initialized: false,
  persistenceVersion: 0,
};

/**
 * 记录某群当前 lockdown 记录是否已确认落盘，而非 lockdown 本身——真正的
 * 私密模式状态在 ChatState.lockdown（stateStore 持有）。initAntiRaid 启动时
 * 先清空，再用已加载的 state.json 记录播种（能载入即视为上次已持久化）；
 * Worker 报告新 lockdown 意图或 unlock（onEvent）时先删除旧指纹，
 * persistCurrentLockdown 待 saveState 成功且记录未被更新覆盖后才重新写入
 * 并通知 Worker；主线程紧急恢复权限成功后同样删除。仅供
 * antiRaid/lockdownMirror.ts 构建 adopt 消息时判断某条记录是否已知持久化。
 */
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
