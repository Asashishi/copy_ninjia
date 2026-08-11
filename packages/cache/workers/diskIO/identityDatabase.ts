import { closeIdentityDatabase } from "../../../database/interact/identity";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type { IdentityPersistenceReply } from "../../../types/diskIO";
import type { IdentityDatabase } from "../../../types/identityDatabase";
import type {
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";

/** Disk I/O Worker 独占的 SQLite 连接与三表写缓冲。 */

/**
 * 30 秒 timer 使用的 ACK 通道；Worker 启动时填充，随整个 DiskIO isolate 销毁。
 * 它不跨线程共享，只由本 Worker 的 SQLite owner 读写。
 */
export const identityPersistenceReplyHolder: {
  current: IdentityPersistenceReply | null;
} = { current: null };

/** SQLite 连接句柄；只在本 Worker isolate 内填充和释放。 */
export const identityDatabaseHandle: { current: IdentityDatabase | null } = {
  current: null,
};

/** 白名单未提交最终值；容量达到 128 即触发一次显式事务。 */
export const pendingWhitelistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 黑名单未提交最终值；容量达到 128 即触发一次显式事务。 */
export const pendingBlocklistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/** 待踢成员未提交行变化；容量达到 128 即触发一次显式事务。 */
export const pendingRemovalWrites: Map<number, PendingRemovalWrite> = new Map();

/**
 * Worker 当前待踢成员权威快照。启动从 SQLite 恢复，之后由主线程完整快照替换；
 * 只用于计算行级 diff，容量受 outbox 业务硬顶约束。
 */
export const removalSnapshot: Map<number, PendingBlockedRemoval> = new Map();

/**
 * 与 removalSnapshot 逐主键对齐的**已编码规范文本**，只用于行级变更比较。
 *
 * 两张表必须同增同删（hydrate 灌入、快照替换、行删除三条路径）。存它的理由是
 * 变更比较需要的正是这段文本：不缓存的话每来一次完整快照，就要对每一条**已存储**
 * 的 removal 重新 stringify + parse + 全量校验一遍，只为算出「它没变」。
 */
export const removalSnapshotData: Map<number, string> = new Map();

/** 当前待写变化全部提交后可确认的最新主线程 outbox revision。 */
export const pendingRemovalSnapshotRevision: { current: number | null } = {
  current: null,
};

/** Worker 本代际已接收的最高 outbox revision，用于拒绝迟到快照。 */
export const latestRemovalSnapshotRevision: { current: number } = { current: 0 };

/** 第一条未提交变化建立的 30 秒固定截止 timer。 */
export const identityWriteFlushTimer: {
  current: ReturnType<typeof setTimeout> | null;
} = { current: null };

/**
 * 「这一轮有身份消息压根没进写缓冲」的领域标记，语义同 joinLog 的 `rejected`。
 *
 * 校验失败（互斥冲突、非法 revision、孤儿冻结名单）此前是裸抛，会把整条落盘线程
 * 带走。改成就地拒收后必须留下痕迹：主线程要靠下一次领域 flush 的失败回执才知道
 * 这条最终值没能落盘（`/block` 的 confirmBlocklistPersisted 正是这么问的），
 * 否则它会把「Worker 丢掉了这条消息」读成「已经 durable」。
 * 由 pendingIdentityDatabaseDomains() 取走并清空，避免一次拒收让此后每一轮
 * flush 都永久报失败。
 */
export const rejectedIdentityDomains: Set<
  "whitelist" | "blocklist" | "blocklistRemovalOutbox"
> = new Set();

/** 记下某个身份领域本轮拒收了一条消息；下一次 flush 会按该领域回报失败。 */
export function noteIdentityWriteRejected(
  domain: "whitelist" | "blocklist" | "blocklistRemovalOutbox"
): void {
  rejectedIdentityDomains.add(domain);
}

/** Worker load/重建前重置同 isolate 状态，避免测试与重复显式 hydrate 污染。 */
export function resetIdentityDatabaseCache(): void {
  if (identityDatabaseHandle.current !== null) {
    closeIdentityDatabase(identityDatabaseHandle.current);
  }
  identityDatabaseHandle.current = null;
  pendingWhitelistWrites.clear();
  pendingBlocklistWrites.clear();
  pendingRemovalWrites.clear();
  removalSnapshot.clear();
  removalSnapshotData.clear();
  pendingRemovalSnapshotRevision.current = null;
  latestRemovalSnapshotRevision.current = 0;
  rejectedIdentityDomains.clear();
  if (identityWriteFlushTimer.current !== null) {
    clearTimeout(identityWriteFlushTimer.current);
    identityWriteFlushTimer.current = null;
  }
}
