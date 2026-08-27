import { closeStorageDatabase } from "../../../database/interact/connection";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type { IdentityPersistenceReply } from "../../../types/diskIO/replies";
import type {
  StorageDatabase,
  StoredIdentityIdLookups,
} from "../../../types/storageDatabase";
import type {
  PendingChatQaWrite,
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";

/** Disk I/O Worker 独占的 SQLite 连接与业务表写缓冲。 */

/**
 * Owner: Disk I/O Worker。
 *
 * 每条连接两条预编译的主键存在性语句（白/黑名单各一），首次用到时由
 * workers/diskIO/storageDatabase/identityPolicy.ts 建好放进来。写入路径按条目调用
 * assertOppositePolicyAbsent，因此同一连接必须复用预编译语句。
 *
 * 容量固定为「每条活着的连接一项」，而本线程同时只持有一条连接，因此无淘汰需求。
 * 清理交给 GC：键是连接对象本身，连接被换掉后整项随之回收，本表不额外持有强引用。
 * 之所以按连接存而不是做成模块级单例——库句柄会被整个换掉（重开库、测试重建），
 * 而 SQLite 预编译语句绑在它自己的连接上，跨连接复用会在旧连接关闭后失效。
 * Worker 崩溃重建后是全新 isolate，本表随之为空，下一次调用重新预编译。
 */
export const storedIdentityIdLookups: WeakMap<
  StorageDatabase,
  StoredIdentityIdLookups
> = new WeakMap<StorageDatabase, StoredIdentityIdLookups>();

/**
 * 30 秒 timer 使用的 ACK 通道；Worker 启动时填充，随整个 DiskIO isolate 销毁。
 * 它不跨线程共享，只由本 Worker 的 SQLite owner 读写。
 */
export const storagePersistenceReplyHolder: {
  current: IdentityPersistenceReply | null;
} = { current: null };

/** SQLite 连接句柄；只在本 Worker isolate 内填充和释放。 */
export const storageDatabaseHandle: { current: StorageDatabase | null } = {
  current: null,
};

/** 白名单未提交最终值；容量达到 128 即触发一次显式事务。 */
export const pendingWhitelistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 黑名单未提交最终值；容量达到 128 即触发一次显式事务。 */
export const pendingBlocklistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 待踢成员未提交行变化；容量达到 128 即触发一次显式事务。 */
export const pendingRemovalWrites: Map<number, PendingRemovalWrite> = new Map();

/** 群状态未提交最终值；容量达到 25 时仍由显式事务整体提交。 */
export const pendingChatStateWrites: Map<number, PendingChatStateWrite> = new Map();

/**
 * 群问答未提交最终值，外层按群、内层按问题文本。
 *
 * 容量天然有界：受管群不超过 STATE_MANAGED_CHAT_LIMIT，每群问答不超过
 * CHAT_QA_MAX_PER_CHAT，因此整个缓冲恒定不超过 375 条，不需要额外淘汰策略。
 * 一群的最后一条被提交或删除后，外层那一项随之移除，空 Map 不留存。
 */
export const pendingChatQaWrites: Map<number, Map<string, PendingChatQaWrite>> = new Map();

/**
 * Worker 当前待踢成员权威快照。启动从 SQLite 恢复，之后由主线程完整快照替换；
 * 只用于计算行级 diff，容量受 outbox 业务硬顶约束。
 */
export const removalSnapshot: Map<number, PendingBlockedRemoval> = new Map();

/**
 * 与 removalSnapshot 逐主键对齐的已编码规范文本，只用于行级变更比较。
 * hydrate、快照替换与删除路径必须让两张 Map 同增同删。
 */
export const removalSnapshotData: Map<number, string> = new Map();

/** 当前待写变化全部提交后可确认的最新主线程 outbox revision。 */
export const pendingRemovalSnapshotRevision: { current: number | null } = {
  current: null,
};

/** Worker 本代际已接收的最高 outbox revision，用于拒绝迟到快照。 */
export const latestRemovalSnapshotRevision: { current: number } = { current: 0 };

/** 第一条未提交变化建立的 30 秒固定截止 timer。 */
export const storageWriteFlushTimer: {
  current: ReturnType<typeof setTimeout> | null;
} = { current: null };

/**
 * 本轮未进入写缓冲的拒收领域；统一 flush 取走后清空，避免永久失败。
 * 容量最多为四个持久化领域，Worker 重建时由 reset 清空。
 */
export const rejectedStorageDomains: Set<
  "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState" | "chatQa"
> = new Set();

/** 记下某个存储领域本轮拒收的一条消息；下一次 flush 会按该领域回报失败。 */
export function noteStorageWriteRejected(
  domain: "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState" | "chatQa"
): void {
  rejectedStorageDomains.add(domain);
}

/** Worker load/重建前重置同 isolate 状态，避免重复显式 hydrate 污染。 */
export function resetStorageDatabaseCache(): void {
  if (storageDatabaseHandle.current !== null) {
    closeStorageDatabase(storageDatabaseHandle.current);
  }
  storageDatabaseHandle.current = null;
  pendingWhitelistWrites.clear();
  pendingBlocklistWrites.clear();
  pendingRemovalWrites.clear();
  pendingChatStateWrites.clear();
  pendingChatQaWrites.clear();
  removalSnapshot.clear();
  removalSnapshotData.clear();
  pendingRemovalSnapshotRevision.current = null;
  latestRemovalSnapshotRevision.current = 0;
  rejectedStorageDomains.clear();
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
}
