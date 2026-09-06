import type { VerificationSnapshot } from "../antiRaid/verification";
import type { PendingBlockedRemoval } from "../blocklist";
import type { IdentityPolicyTable } from "../identityPolicy";
import type { ChatState } from "../chatState";
import type { FlushResult } from "../lifecycle";
import type {
  JoinLogRecord,
  LuckDayCache,
  LuckReceiptSecret,
} from "./storage";
import type { BlocklistIdPage } from "../identityStorage";
import type { StoredTemporaryWhitelistActivity } from "../temporaryWhitelist";
/** diskIOWorker -> 主线程：启动恢复读盘完成。两张快照表的值与增量写入
 * 消息同形态——序列化 JSON 文本（恢复时逐字段重建校验后重新 stringify，
 * 见 workers/diskIO/snapshotFiles.ts），供 hydrate 链路直接透传。 */
export interface LoadedReply {
  type: "loaded";
  /** /wed 已发言成员集合；DiskIO 校验时建立，经消息复制后由主线程直接接管。 */
  wedMembers: ReadonlyMap<number, Set<number>>;
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  luckReceiptSecret: LuckReceiptSecret | null;
  verifications: Map<string, VerificationSnapshot>;
  /** 未完成的黑名单成员移除 outbox；主线程过滤后在 Anti-Raid 初始化时重放。 */
  pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
  /** 黑名单总条目数；主线程只保留计数与有界 LRU，不恢复整表。 */
  blocklistEntryCount: number;
  /** 白名单总条目数；主线程只保留计数与有界 LRU，不恢复整表。 */
  whitelistEntryCount: number;
  /** 当前格式的全部群状态；主线程据此建立同容量 LRU，不重复启动正确性校验。 */
  chatStates: Map<number, ChatState>;
  /** 全部群问答；整表恒定不超过 375 行，主线程据此建立直答热表。 */
  chatQa: Map<number, ReadonlyMap<string, string>>;
  /** 恢复失败时主线程必须拒绝启动，不能把部分结果当成空状态继续。 */
  error?: string;
}

/**
 * 启动恢复交给应用生命周期的完整数据。AI 记忆与贴纸目录仍是已校验后重新
 * 序列化的 JSON 文本；SQLite 群状态信任当前写入格式，只恢复进热缓存。
 */
export interface LoadedData {
  wedMembers: ReadonlyMap<number, Set<number>>;
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  luckReceiptSecret: LuckReceiptSecret;
  verifications: Map<string, VerificationSnapshot>;
  pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
  blocklistEntryCount: number;
  whitelistEntryCount: number;
  chatStates: Map<number, ChatState>;
  /** 群 -> 问题 -> 答案；整表恒定不超过 375 行，启动一次性读全。 */
  chatQa: Map<number, ReadonlyMap<string, string>>;
}

/** ensureLuckSecret 的逐请求回执；失败时不返回密钥，主线程不得继续抽签。 */
export interface LuckSecretReply {
  type: "luckSecret";
  requestId: number;
  secret?: LuckReceiptSecret;
  error?: string;
}

/** diskIOWorker -> 主线程：`/batch_kick` 的按需入群日志查询结果。 */
export interface JoinLogReadReply {
  type: "joinLogRead";
  requestId: number;
  records?: readonly JoinLogRecord[];
  error?: string;
}

/** Disk I/O Worker -> 主线程：一次身份策略与临时白名单累计批量读取。 */
export interface IdentityPoliciesReadReply {
  type: "identityPoliciesRead";
  requestId: number;
  whitelist?: readonly (readonly [number, string])[];
  blocklist?: readonly (readonly [number, string])[];
  temporaryWhitelist?: readonly StoredTemporaryWhitelistActivity[];
  error?: string;
}

/** Disk I/O Worker -> 主线程：群级补扫所需的有界黑名单主键页。 */
export interface BlocklistIdPageReadReply {
  type: "blocklistIdPageRead";
  requestId: number;
  page?: BlocklistIdPage;
  error?: string;
}

/** 一项黑白名单最终值已由显式 SQLite 事务提交。 */
export interface IdentityPolicyPersistedRevision {
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly revision: number;
}

/** 一项临时白名单累计最终值已由显式 SQLite 事务提交。 */
export interface TemporaryWhitelistPersistedRevision {
  readonly id: number;
  readonly revision: number;
}

/** 一群最终状态已经由显式 SQLite 事务提交。 */
export interface ChatStatePersistedRevision {
  readonly chatId: number;
  readonly revision: number;
}

/** 一条群问答最终值已经由显式 SQLite 事务提交；主键是 (chatId, q) 复合键。 */
export interface ChatQaPersistedRevision {
  readonly chatId: number;
  readonly q: string;
  readonly revision: number;
}

/** Disk I/O Worker -> 主线程：清理最终一致性重放缓冲的事务 ACK。 */
export interface IdentityStoragePersistedReply {
  type: "identityStoragePersisted";
  writes: readonly IdentityPolicyPersistedRevision[];
  /** 本事务提交的临时白名单累计 revision。 */
  temporaryWhitelistWrites: readonly TemporaryWhitelistPersistedRevision[];
  /** 本事务提交的群状态 revision；与身份策略共享同一 SQLite 事务。 */
  chatStateWrites: readonly ChatStatePersistedRevision[];
  /** 本事务提交的群问答 revision；与群状态共享同一 SQLite 事务。 */
  chatQaWrites: readonly ChatQaPersistedRevision[];
  /** 本事务覆盖到的最新待踢成员快照修订号。 */
  removalSnapshotRevision?: number;
}

/** Disk I/O Worker 在 SQLite 事务 durable 后发送精确 ACK 的线程内回调。 */
export type IdentityPersistenceReply = (
  reply: IdentityStoragePersistedReply
) => void;

/**
 * 统一 flush 覆盖的落盘领域。回执按领域拆开，是为了让「等自己这条记录
 * 落盘」的调用方（典型是 /block）不会因为无关领域失败而误报——那会把运维
 * 引向一个其实没坏的文件，而真正坏掉的领域按设计只有 console.error，
 * 永远进不了 logs/（见 workers/diskIOWorker.ts 的 flushAll）。
 */
export type DiskIODomain =
  | "log"
  | "aiMemory"
  | "stickerCatalog"
  | "wedMembers"
  | "luck"
  | "verification"
  | "whitelist"
  | "blocklist"
  | "temporaryWhitelist"
  | "blocklistRemovalOutbox"
  | "chatState"
  | "chatQa"
  | "joinLog";

/**
 * 单领域 flush 的结局，附带**发起这一次请求所收到的**失败领域名。
 *
 * failedDomains 只在 Worker 明确回复了本次 flushId 时存在；超时、传输失败、
 * Worker 崩溃中途结算都没有回执，此时必须保持 undefined——把别的 flush 留下
 * 的领域名安到这一次头上，会让运维照着一个其实与本次失败无关的文件去查。
 */
export interface DomainFlushOutcome {
  result: FlushResult;
  failedDomains?: readonly DiskIODomain[];
}

/** diskIOWorker -> 主线程：flush 已完成，各领域全部落盘。 */
export interface DiskFlushReply {
  type: "flushed";
  flushedId: number;
}

/** diskIOWorker -> 主线程：至少一个领域仍 dirty 或本轮写入失败。 */
export interface DiskFlushFailedReply {
  type: "flushFailed";
  flushedId: number;
  /** 本轮没能落盘的领域；其余领域已经写进去了。 */
  failedDomains: readonly DiskIODomain[];
}

/** diskIOWorker -> 主线程：指定诊断批次已同步消费，发送窗口可以继续前进。 */
export interface DiskDiagnosticBatchAcceptedReply {
  readonly type: "diagnosticBatchAccepted";
  readonly batchId: number;
}

/** diskIOWorker -> 主线程：该批日志尚未 durable，保留原批并在退避后重发。 */
export interface DiskDiagnosticBatchRetryReply {
  readonly type: "diagnosticBatchRetry";
  readonly batchId: number;
  readonly retryAfterMs: number;
}

/** diskIOWorker -> 主线程：一条验证变化已经进入当天 JSON 文件。 */
export interface VerificationPersistedReply {
  type: "verificationPersisted";
  /** 待验证落盘键，固定为 `chatId:userId`。 */
  key: string;
  generation: number;
  revision: number;
  deleted: boolean;
}

/** diskIOWorker -> 主线程：指定 revision 的删除已 durable，或已被更新 revision 覆盖。 */
export interface AiMemoryDeletedPersistedReply {
  type: "aiMemoryDeletedPersisted";
  chatId: number;
  revision: number;
}

/** diskIOWorker -> 主线程：要求即时写入的 AI 记忆 revision 已 durable。 */
export interface AiMemoryPersistedReply {
  type: "aiMemoryPersisted";
  chatId: number;
  revision: number;
}

/**
 * diskIOWorker -> 主线程：当日运势追加已连续失败到阈值，条目仍滞留在 Worker 内存。
 *
 * 这是 Worker 侧写盘失败里**唯一**会被转成 `logger.error` 的一条，因此不是对
 * 「Worker 内部错误只 console.error」的推翻，而是一条窄口径的例外：它报的不是
 * 某一次 write(2) 的错，而是「一个领域已经持续丢数据」这件事实——而运势的丢失
 * 在别处完全无迹可寻（主线程 dailyLuckCache 照常命中，用户看不出异常）。
 * 递归风险为零：主线程据此记的日志走 log 领域，log 领域自己写失败只 console.error，
 * 不会再产生第二条 logger 调用。
 * @see ../../docs/cn/04-invariants.md
 */
export interface LuckAppendStalledReply {
  type: "luckAppendStalled";
  /** 写不进去的那一天（YYYY-MM-DD），即 memory/luck/<day>.json。 */
  day: string;
  /** 告警时刻仍未落盘的条目数；故障持续时实际丢失量只会比它更大。 */
  pendingEntries: number;
  /** 连续失败次数，等于触发阈值。 */
  consecutiveFailures: number;
  /** 最近一次追加失败的错误文本，供运维直接判读是权限、只读卷还是磁盘满。 */
  error: string;
}

/**
 * diskIOWorker -> 主线程：恢复缓冲重放期间有一条业务事实没能写进去。
 *
 * 与 LuckAppendStalledReply 一样是「Worker 内部错误只 console.error」的窄口径例外，
 * 但走的不是日志而是停机：这条事实对应的 update 已经被确认过了（见
 * RecoveryReplayRequest），继续跑下去就是一次无迹可寻的静默丢数据。主线程收到后
 * 按 stopWorkerAfterLoadFailure 的统一 fatal 路径停机，让 Telegram 从上一个确认点
 * 重投。
 */
export interface RecoveryReplayFailedReply {
  type: "recoveryReplayFailed";
  /** 出错的业务消息类型，供运维直接判读是哪个领域。 */
  domain: DiskIODomain;
  /** 错误文本；不含任何消息内容，避免把用户数据写进诊断。 */
  error: string;
}

/** 操作批次已顺序执行；SQLite 和快照 durable ACK 仍使用各自回执。 */
export interface DiskOperationBatchAcceptedReply {
  readonly type: "operationBatchAccepted";
  readonly batchId: number;
}

/** SQLite 连续失败或容量耗尽；宿主停止新业务，仍保留已接收事实供最终 flush。 */
export interface StorageWriteStalledReply {
  readonly type: "storageWriteStalled";
}

/** 统一东京午夜 cron 通知主线程启动日级维护；不携带成员集合，不在 Worker 重建时重放。 */
export interface MidnightMaintenanceReply {
  readonly type: "midnightMaintenance";
  readonly day: string;
}

export type DiskIOReply =
  | MidnightMaintenanceReply
  | DiskOperationBatchAcceptedReply
  | StorageWriteStalledReply
  | LoadedReply
  | DiskDiagnosticBatchAcceptedReply
  | DiskDiagnosticBatchRetryReply
  | RecoveryReplayFailedReply
  | LuckSecretReply
  | JoinLogReadReply
  | IdentityPoliciesReadReply
  | BlocklistIdPageReadReply
  | IdentityStoragePersistedReply
  | DiskFlushReply
  | DiskFlushFailedReply
  | VerificationPersistedReply
  | AiMemoryPersistedReply
  | AiMemoryDeletedPersistedReply
  | LuckAppendStalledReply;
