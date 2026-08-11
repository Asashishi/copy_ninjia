import type { PendingBlockedRemoval } from "./blocklist";

/** Disk I/O 回执路由层尚未解码的两表 JSON 文本。 */
export interface IdentityPolicyRawReadResult {
  readonly whitelist: readonly (readonly [number, string])[];
  readonly blocklist: readonly (readonly [number, string])[];
}

/** 主线程按表和主键保留到事务 ACK 的最终值。 */
export interface UnacknowledgedIdentityWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** Disk I/O Worker 同一名单主键在事务提交前保留的最新最终值。 */
export interface PendingIdentityPolicyWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** Disk I/O Worker 待踢成员按快照 diff 后的单行最终值。 */
export interface PendingRemovalWrite {
  readonly data: string | null;
}

/** 身份数据库启动恢复交给主线程的有界结果。 */
export interface IdentityDatabaseHydration {
  readonly blocklistEntryCount: number;
  readonly whitelistEntryCount: number;
  readonly pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
}
