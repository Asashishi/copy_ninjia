import type { PendingBlockedRemoval } from "./blocklist";
import type { ChatState } from "./chatState";

/** Disk I/O 回执路由层尚未解码的两表 JSON 文本。 */
export interface IdentityPolicyRawReadResult {
  readonly whitelist: readonly (readonly [number, string])[];
  readonly blocklist: readonly (readonly [number, string])[];
}

/** SQLite 按主键稳定顺序返回的一页黑名单 ID；载荷受固定页大小硬顶。 */
export interface BlocklistIdPage {
  readonly ids: readonly number[];
  /** 本页最后一个主键；空页保持请求游标，完成页不再使用它续读。 */
  readonly nextCursor: number | null;
  /** true 表示当前游标之后已没有更多有效黑名单主键。 */
  readonly done: boolean;
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

/** Disk I/O Worker 同一群主键在事务提交前保留的最新最终值。 */
export interface PendingChatStateWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** 一条群问答的未提交最终值；`data` 为 null 表示删除这条问答。 */
export interface PendingChatQaWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** 主线程保留到 SQLite ACK 的最小群状态恢复元数据；正文只存在于 LRU。 */
export interface UnacknowledgedChatStateWrite {
  readonly revision: number;
  readonly deleted: boolean;
}

/** 共享存储数据库启动恢复交给主线程的有界结果。 */
export interface StorageDatabaseHydration {
  readonly blocklistEntryCount: number;
  readonly whitelistEntryCount: number;
  readonly pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
  readonly chatStates: Map<number, ChatState>;
  /**
   * 群 -> 问题 -> 答案。整表恒定不超过 125 行（受管群 × 每群 5 条），因此启动
   * 一次性读全，不像 outbox 那样分页。
   */
  readonly chatQa: Map<number, ReadonlyMap<string, string>>;
}
