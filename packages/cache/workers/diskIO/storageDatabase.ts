/** owner: workers/diskIO。独占的 SQLite 连接与业务表写缓冲。 */

import { closeStorageDatabase } from "../../../database/interact/connection";
import { StorageWriteBudget } from "../../../libs/storageWriteBudget";
import type {
  BudgetedStorageDomain,
  IdentityPersistenceReply,
  StorageDatabaseDomain,
} from "../../../types/diskIO/replies";
import type {
  StorageDatabase,
  StorageDatabaseWriter,
  StoredIdentityIdLookups,
} from "../../../types/storageDatabase";
import type {
  PendingAiContextWrite,
  PendingChatQaWrite,
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";
import type { PendingTemporaryAdBypassWrite } from
  "../../../types/temporaryAdBypass";

/**
 * 各领域（BudgetedStorageDomain）的未 ACK 条目与字节预算，上限与主线程逐领域准入一致，
 * Worker 重建时主线程重放的已接纳写入据此重新预约。写前预约、事务成功由 resetStoragePendingBudgets
 * 全部清空；每个领域一项；Worker 重建后为新 isolate 的初值。
 */
export const storagePendingBudgets: Readonly<Record<BudgetedStorageDomain, StorageWriteBudget>> = {
  whitelist: new StorageWriteBudget(),
  blocklist: new StorageWriteBudget(),
  temporaryAdBypass: new StorageWriteBudget(),
  blocklistRemovalOutbox: new StorageWriteBudget(),
  chatState: new StorageWriteBudget(),
  chatQa: new StorageWriteBudget(),
};

/** 统一事务成功或 Worker 重置时清空全部领域预算。 */
export function resetStoragePendingBudgets(): void {
  for (const budget of Object.values(storagePendingBudgets)) budget.reset();
}

/** 连续失败与重试截止；成功或重建复位，达到失败上限通知宿主一次。 */
export const storageWriteRetry: { failures: number; retryAt: number; signaled: boolean } = {
  failures: 0, retryAt: 0, signaled: false,
};

/** 启动安装的容量/持续失败通知；容量一项，isolate 销毁后重新安装。 */
export const storageWriteFatalReply: { current: (() => void) | null } = { current: null };

/**
 * 每条连接上永久白名单、永久黑名单与临时广告免检各一条预编译的主键存在性语句，首次由
 * workers/diskIO/storageDatabase/identityPolicy.ts 建好放进来。写入路径按条目调用
 * assertOppositePolicyAbsent，复用同一连接的预编译语句。
 *
 * 容量为每条活着的连接一项，本线程同时只持有一条连接，不设淘汰。
 * 清理交给 GC：键是连接对象本身，连接被换掉后整项随之回收，本表不额外持有强引用。
 * 预编译语句绑定所属连接，库句柄被整个换掉（重开库、测试重建）后按新连接重新建立。
 * Worker 崩溃重建后是全新 isolate，本表随之为空，下一次调用重新预编译。
 */
export const storedIdentityIdLookups: WeakMap<
  StorageDatabase,
  StoredIdentityIdLookups
> = new WeakMap<StorageDatabase, StoredIdentityIdLookups>();

/**
 * 每条连接一整套统一事务提交用的预编译写语句，首次提交时由
 * workers/diskIO/storageDatabase/flush.ts 建好放进来，同一连接的每次提交复用。容量、清理与
 * Worker 重建口径同 storedIdentityIdLookups：每条活着的连接一项，键随连接回收，关库时
 * `close(true)` 一并结束这些语句。
 */
export const storageDatabaseWriters: WeakMap<
  StorageDatabase,
  StorageDatabaseWriter
> = new WeakMap<StorageDatabase, StorageDatabaseWriter>();

/**
 * 固定截止 timer 使用的 ACK 通道；Worker 启动时填充，随整个 DiskIO isolate 销毁。
 * 不跨线程共享，只由本 Worker 的 SQLite owner 读写。
 */
export const storagePersistenceReplyHolder: {
  current: IdentityPersistenceReply | null;
} = { current: null };

/** SQLite 连接句柄；只在本 Worker isolate 内填充和释放。 */
export const storageDatabaseHandle: { current: StorageDatabase | null } = {
  current: null,
};

/**
 * 停机已关库（workers/diskIO/storageDatabase/shutdown.ts）。置位后到达的身份写消息直接忽略，
 * AI 上下文写只进缓冲，提交与定时提交都不再执行；resetStorageDatabaseCache 复位，容量为
 * 一个布尔值。Worker 重建后为新 isolate 的初值 false。
 */
export const storageDatabaseClosed: { current: boolean } = { current: false };

/**
 * 白名单未提交最终值；条数达到 IDENTITY_WRITE_BATCH_MAX_ENTRIES 即触发一次显式事务。
 * 提交成功后由 flush 清空，失败时保留给固定截止 timer 重试；resetStorageDatabaseCache
 * 也会清空。Worker 重建后为空，主线程以未 ACK revision 重放最终值。
 */
export const pendingWhitelistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/**
 * 黑名单未提交最终值；条数达到 IDENTITY_WRITE_BATCH_MAX_ENTRIES 即触发一次显式事务。
 * 清理与重建路径同 pendingWhitelistWrites。
 */
export const pendingBlocklistWrites: Map<number, PendingIdentityPolicyWrite> = new Map();

/**
 * 临时广告免检累计未提交最终值；消息到达时按身份合并，条数达到 IDENTITY_WRITE_BATCH_MAX_ENTRIES 即触发事务。
 * 成功提交后由 flush 清理，失败时保留给固定截止 timer 重试；Worker 重建后为空，
 * 主线程以未 ACK revision 重放最终值。
 */
export const pendingTemporaryAdBypassWrites: Map<
  number,
  PendingTemporaryAdBypassWrite
> = new Map();

/**
 * 待踢成员未提交行变化；条数达到 IDENTITY_WRITE_BATCH_MAX_ENTRIES 即触发一次显式事务。
 * 清理与重建路径同 pendingWhitelistWrites。
 */
export const pendingRemovalWrites: Map<number, PendingRemovalWrite> = new Map();

/**
 * 群状态未提交最终值；达到 STATE_MANAGED_CHAT_LIMIT 群时由显式事务整体提交。
 * 清理与重建路径同 pendingWhitelistWrites。
 */
export const pendingChatStateWrites: Map<number, PendingChatStateWrite> = new Map();

/**
 * 群问答未提交最终值，外层按群、内层按问题文本。
 *
 * 活跃问答受群数和每群容量限制；删除墓碑与正文共同占用 chatQa 领域预算，
 * 超限拒收新事实，提交成功后才释放，Worker 重建由主线程重放未 ACK 最终值。
 * 一群的最后一条被提交或删除后，外层那一项随之移除，空 Map 不留存。
 */
export const pendingChatQaWrites: Map<number, Map<string, PendingChatQaWrite>> = new Map();

/**
 * pendingChatQaWrites 内层条目总数（含删除墓碑），供批次阈值判定直接读取，不在每次
 * 写入时遍历各群。与内层条目同增同删：新 (chatId, q) 进缓冲时加一，事务提交摘除
 * 条目时减一，resetStorageDatabaseCache 归零；Worker 重建后从零开始，随主线程重放
 * 重新累计。
 */
export const pendingChatQaEntryCount: { current: number } = { current: 0 };

/**
 * AI 上下文未提交最终值，按群一份；事务内排在群状态之后按主键更新 `ai_context`，
 * 群行不存在时不插入。填充：aiMemoryStorage.ts 按 revision 接受 upsert 或删除时覆盖；
 * 清理：提交成功后由 flush 摘除，失败保留重试，resetStorageDatabaseCache 清空。容量：
 * 每群至多一项，上界 AI_MEMORY_MAX_CHATS，不计入 storagePendingBudgets。Worker 重建后为空，
 * 主线程重放最新快照与未确认删除墓碑。
 */
export const pendingAiContextWrites: Map<number, PendingAiContextWrite> = new Map();

/**
 * Worker 当前待踢成员权威快照的已编码规范文本，按 removalId 索引，只用于计算
 * 行级 diff。启动从 SQLite 恢复，之后由主线程完整快照替换；容量受 outbox 业务硬顶
 * （BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES）约束。
 *
 * 清理：每次主线程快照整体替换时按 diff 删除消失的行，
 * resetStorageDatabaseCache 整表清空。Worker 重建：从 SQLite 重新 hydrate，
 * 随后主线程重放最新 outbox 快照。
 */
export const removalSnapshotData: Map<number, string> = new Map();

/** 当前待写变化全部提交后可确认的最新主线程 outbox revision。 */
export const pendingRemovalSnapshotRevision: { current: number | null } = {
  current: null,
};

/** Worker 本代际已接收的最高 outbox revision，用于拒绝迟到快照。 */
export const latestRemovalSnapshotRevision: { current: number } = { current: 0 };

/**
 * Worker 重建后的镜像重放区间是否打开。由主线程 `storageFlushHold` 标记开合
 * （见 types/diskIO/messages.ts 的 StorageFlushHoldRequest）；为 true 时满批、定时与
 * AI 上下文的即时提交暂缓。新 Worker 与 resetStorageDatabaseCache 从 false 起步，容量为一个布尔值。
 */
export const storageFlushHold: { current: boolean } = { current: false };

/** 第一条未提交变化建立的固定截止 timer，间隔为 IDENTITY_WRITE_FLUSH_INTERVAL_MS。 */
export const storageWriteFlushTimer: {
  current: ReturnType<typeof setTimeout> | null;
} = { current: null };

/**
 * 本轮未进入写缓冲的拒收领域；单领域 flush 只取走本领域的标记，all/business flush
 * 取走全部，取走即清除。容量不超过共享 SQLite 持久化领域数
 * （StorageDatabaseDomain，含 AI 上下文），Worker 重建时由 reset 清空。
 */
export const rejectedStorageDomains: Set<StorageDatabaseDomain> = new Set();

/** Worker load/重建前重置同 isolate 状态，避免重复显式 hydrate 污染。 */
export function resetStorageDatabaseCache(): void {
  resetStoragePendingBudgets();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  if (storageDatabaseHandle.current !== null) {
    closeStorageDatabase(storageDatabaseHandle.current);
  }
  storageDatabaseHandle.current = null;
  storageDatabaseClosed.current = false;
  pendingWhitelistWrites.clear();
  pendingBlocklistWrites.clear();
  pendingTemporaryAdBypassWrites.clear();
  pendingRemovalWrites.clear();
  pendingChatStateWrites.clear();
  pendingChatQaWrites.clear();
  pendingChatQaEntryCount.current = 0;
  pendingAiContextWrites.clear();
  removalSnapshotData.clear();
  pendingRemovalSnapshotRevision.current = null;
  latestRemovalSnapshotRevision.current = 0;
  rejectedStorageDomains.clear();
  storageFlushHold.current = false;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
}
