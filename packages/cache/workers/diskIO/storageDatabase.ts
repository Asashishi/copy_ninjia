import { closeStorageDatabase } from "../../../database/interact/connection";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type { IdentityPersistenceReply } from "../../../types/diskIO";
import type { StorageDatabase } from "../../../types/storageDatabase";
import type {
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";

/** Disk I/O Worker 独占的 SQLite 连接与业务表写缓冲。 */

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
  "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState"
> = new Set();

/** 记下某个存储领域本轮拒收的一条消息；下一次 flush 会按该领域回报失败。 */
export function noteStorageWriteRejected(
  domain: "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState"
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
