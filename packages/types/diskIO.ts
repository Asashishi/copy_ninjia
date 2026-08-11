import type { AdSampleMessage, VerificationSnapshot } from "./antiRaid";
import type { PendingBlockedRemoval } from "./blocklist";
import type { IdentityPolicyTable } from "./identityPolicy";
import type { FlushResult } from "./lifecycle";
import type {
  JoinLogRecord,
  LuckDayCache,
  LuckReceiptSecret,
} from "./diskIO/storage";
export type * from "./diskIO/storage";

/**
 * 磁盘 IO 线程（packages/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI/贴纸快照、每日运势、待验证当日增量与身份 SQLite 共用同一个
 * Worker。快照的结构
 * 类型（AiMemorySnapshot/StickerCatalogSnapshot）见 types/aiChat.ts——
 * 消息里只带它们序列化后的 JSON 文本。
 */

export type LogLevel = "log" | "info" | "warn" | "error";

/** 一条日志的内容（不含 type 标；也是 Worker 日志转发批次的元素形状）。 */
export interface LogMessage {
  timestamp: number;
  level: LogLevel;
  args: unknown[];
}

/** Worker 线程 -> 主线程：单批在途、有界待发送 FIFO 中的一批 error 日志。 */
export interface ForwardedLogBatch {
  readonly __logBatch: {
    readonly batchId: number;
    readonly messages: readonly LogMessage[];
  };
}

/** 主线程 -> Worker 线程：已消费指定日志批次，允许发送下一批。 */
export interface ForwardedLogBatchAccepted {
  readonly __logBatchAccepted: number;
}

/** 主线程/转发 -> diskIOWorker：落盘一条日志。 */
export interface LogEnvelope extends LogMessage {
  type: "log";
}

/** 主线程 -> diskIOWorker：覆盖式写入某群的 AI 记忆快照。snapshot 是
 * AiMemorySnapshot 序列化后的 JSON 文本（源头一次 stringify、全程字符串
 * 流转，见 types/aiChat.ts 的 AiMemoryEvent.snapshot），落盘端原样写文件。 */
export interface AiMemoryDiskMessage {
  type: "aiMemory";
  chatId: number;
  /** 进程内按 chat 单调递增；只用于消息竞态，不改变快照文件 schema。 */
  revision: number;
  snapshot: string;
  /** purge 后首份新快照；绕过普通批量窗口，并在 durable 后回执 revision。 */
  persistImmediately?: boolean;
}

/** 主线程 -> diskIOWorker：彻底删除某群 AI 记忆快照。 */
export interface AiMemoryDeleteDiskMessage {
  type: "deleteAiMemory";
  chatId: number;
  revision: number;
}

/**
 * 主线程 -> diskIOWorker：丢弃某群 AI 记忆的 revision 水位线。
 *
 * 只在主线程自己的 revision 计数器归零的同一时刻发出（chat teardown，且已确认
 * 该群没有任何在途快照、墓碑与 waiter，见 aiChat/memoryMirror.ts 的
 * forgetAiMemoryRevisionCounter）。少了这条消息，两侧的水位线作用域就不一致：
 * 主线程从 revision 1 重新开始，Worker 侧还停在删除时的高水位，重新启用后的
 * 快照会被 `revision < currentRevision` 判成迟到消息**静默丢弃**，一直丢到
 * 计数器重新爬过旧水位为止。
 *
 * 不带 revision：它表达的正是「这个 chat 的 revision 序列到此为止」，
 * 而不是某一次状态变更。
 */
export interface AiMemoryForgetDiskMessage {
  type: "forgetAiMemory";
  chatId: number;
}

/** 主线程 -> diskIOWorker：覆盖式写入某个白名单贴纸包的目录快照。snapshot
 * 是 StickerCatalogSnapshot 序列化后的 JSON 文本，机制同 AiMemoryDiskMessage。 */
export interface StickerCatalogDiskMessage {
  type: "stickerCatalog";
  pack: string;
  snapshot: string;
}

/** 主线程 -> diskIOWorker：一次抽签结果的增量写入。 */
export interface LuckDrawDiskMessage {
  type: "luckDraw";
  /** 抽签发生时刻的东京日期（YYYY-MM-DD），由主线程算好带过来，见 commands/luckChallenge/cache.ts。 */
  day: string;
  /** 缓存 key："<userId>" 或 "<userId>:<text 的 sha256 十六进制摘要>"，与
   *  dailyLuckCache 的 key 一致（原文本不直接进 key，见
   *  commands/luckChallenge/key.ts 的 luckCacheKey 注释）。 */
  key: string;
  /** LuckTier.label；加载时按 LUCK_TIERS 反查还原 tier（见 commands/luckChallenge/cache.ts）。 */
  label: string;
  /** 该次抽签在 tier.fortunePercentRange 内浮动出的行大运具体数值（%，两位小数）。
   * 不再能从 label 反查得出（区间是浮动的），必须随 label 一起落盘，见 LuckDrawRecord。 */
  fortunePercent: number;
}

/** 主线程 -> diskIOWorker：待验证 active 快照的最新变化。 */
export interface VerificationUpsertDiskMessage {
  type: "verificationUpsert";
  record: VerificationSnapshot;
  /** 新建验证属于核心状态，绕过普通 250ms 合并窗口。 */
  critical: boolean;
}

/** 主线程 -> diskIOWorker：验证终结；当天增量文件追加 null。 */
export interface VerificationDeleteDiskMessage {
  type: "verificationDelete";
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}

/** 主线程 -> diskIOWorker：覆盖式写入尚未完成的黑名单成员移除 outbox。 */
export interface BlocklistRemovalsDiskMessage {
  type: "blocklistRemovals";
  removals: readonly (readonly [number, PendingBlockedRemoval])[];
  /** 主线程 outbox 快照单调修订号；事务提交后按它回 ACK。 */
  revision: number;
}

/** 主线程 -> Disk I/O Worker：一项黑/白名单最终值；null 表示删除。 */
export interface IdentityPolicyWriteDiskMessage {
  type: "identityPolicyWrite";
  table: IdentityPolicyTable;
  id: number;
  data: string | null;
  /** 主线程同表同主键的单调修订号。 */
  revision: number;
}

/**
 * 主线程 -> diskIOWorker：一条广告判定命中样本，追加进 memory/ad-detected/sample.json。
 *
 * 这是整个持久化里唯一**只写不读**的一类：进程从不加载它，启动恢复也不碰，
 * 丢了不影响任何运行时状态。它存在的唯一目的是让人回头翻原始素材、据此调
 * config/ad_samples.json 的判定口径（见 workers/diskIO/adSampleFile.ts）。
 */
export interface AdSampleDiskMessage {
  type: "adSample";
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  /** 处置播报里的展示标签，人翻样本时用来认人。 */
  label: string;
  /** 命中时刻的东京时间「YYYY/MM/DD HH:mm:ss」，由主线程算好带过来。 */
  detectedAt: string;
  /** 模型给出的判定理由。 */
  reason: string;
  /** 本次判定依据的整串消息（正文，外加只给人看的引用/回复上下文）。 */
  messages: readonly AdSampleMessage[];
}

/**
 * 不进入权威业务恢复缓冲的 Disk I/O 诊断。传输层在进程存活期间保留到 ACK；
 * 各落盘领域是否把写失败升级为业务失败，仍由日志与广告样本各自决定。
 */
export type DiskDiagnosticMessage = LogEnvelope | AdSampleDiskMessage;

/** 主线程 -> diskIOWorker：单批、总消息数与载荷字节均有硬顶的 ACK 诊断批次。 */
export interface DiskDiagnosticBatchRequest {
  readonly type: "diagnosticBatch";
  readonly batchId: number;
  readonly messages: readonly DiskDiagnosticMessage[];
}

/**
 * 主线程 -> diskIOWorker：一条权威 `chat_member` 入群事实。
 * Worker 按群、按东京日期追写；启动恢复不读取这类日志。
 */
export interface JoinLogDiskMessage {
  type: "joinLog";
  chatId: number;
  userId: number;
  joinedAt: number;
  /** joinedAt 对应的东京日期，避免 Worker 重新解释事件时区。 */
  day: string;
}

/** 运行时恢复窗口允许暂存并按序重放的业务持久化消息。 */
export type DiskBusinessMessage =
  | AiMemoryDiskMessage
  | AiMemoryDeleteDiskMessage
  | AiMemoryForgetDiskMessage
  | StickerCatalogDiskMessage
  | LuckDrawDiskMessage
  | VerificationUpsertDiskMessage
  | VerificationDeleteDiskMessage
  | BlocklistRemovalsDiskMessage
  | IdentityPolicyWriteDiskMessage
  | JoinLogDiskMessage;

/**
 * Disk I/O Worker 运行时重建期间的代际限定投递器。
 *
 * 只在当前 respawn listener 返回的 Promise 结算前有效；listener 不得把恢复
 * 工作 fire-and-forget。任一方法失败都必须让本轮恢复保持不可写。领域镜像
 * 不得回退到普通 postDiskIO，否则消息会进入恢复缓冲，无法证明镜像先于缓冲
 * 业务完成。
 */
export interface DiskIORecoveryTransport {
  // readonly：这两个句柄在 createRecoveryTransportScope 里一次绑定后只被调用，
  // 不可变性由类型承担而不是运行期 Object.freeze（见 AGENTS.md 的「常量」一节）。
  readonly post: (this: void, message: DiskBusinessMessage) => boolean;
  readonly ensureLuckReceiptSecret: (this: void, day: string) => Promise<LuckReceiptSecret>;
}

/** 一个必须完整成功，Disk I/O Worker 才能重新公开 writable 的领域镜像。 */
export type DiskIORespawnListener = (
  transport: DiskIORecoveryTransport
) => boolean | Promise<boolean>;

/** 带诊断 owner 的运行时恢复镜像登记。 */
export interface DiskIORespawnRegistration {
  owner: string;
  /** 数值越小越先恢复；同优先级按 owner 稳定排序。 */
  priority: number;
  listener: DiskIORespawnListener;
}

/** diskIOWorker 短窗口内按 key 合并后的最终变化。 */
export interface VerificationFileChange {
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
  value: VerificationSnapshot | null;
}

/** 主线程 -> diskIOWorker：启动恢复（也用于本 Worker 崩溃重建后的自动重跑）。 */
export interface LoadRequest {
  type: "load";
}

/**
 * 主线程 -> diskIOWorker：恢复缓冲重放窗口的开合标记。
 *
 * 一条业务消息「写失败了」在两种到达方式下的收场完全不同。正常在线投递的那条
 * 后面紧跟着调用方自己的领域 flush（见 infra/joinLog.ts），失败由那次 flush 回报，
 * update 不被确认、Telegram 重投即可自愈；而恢复缓冲重放的那条**没有任何人再来
 * flush**——recordJoinLog 早在缓冲那一刻就已经放行了这条 update。Worker 自己看不出
 * 两者的区别，因此由主线程在重放前后各发一条标记把那段区间圈出来：区间内的写失败
 * 只能按 infra/joinLog.ts 承诺的那样走 stopWorkerAfterLoadFailure 的统一 fatal 停机。
 */
export interface RecoveryReplayRequest {
  type: "recoveryReplay";
  /** true = 后续消息来自恢复缓冲重放；false = 重放结束，恢复常规语义。 */
  active: boolean;
}

/** 主线程跨东京日期后要求唯一 Disk I/O Worker 加载或原子轮换日级密钥。 */
export interface EnsureLuckSecretRequest {
  type: "ensureLuckSecret";
  requestId: number;
  day: string;
}

/**
 * 主线程 -> diskIOWorker：dirty 持久化领域立即落盘，随后回执。
 * `business` 仅供诊断日志连续失败后的受控重建前使用；它跳过已知故障的日志领域，
 * 但仍覆盖全部权威业务领域，不能作为普通停机 flush 的降级模式。
 */
export interface DiskFlushRequest {
  type: "flush";
  flushId: number;
  scope: "all" | "business";
}

/** 主线程 -> diskIOWorker：按命令读取本群指定滚动时间窗内的入群记录。 */
export interface ReadJoinLogRequest {
  type: "readJoinLog";
  requestId: number;
  chatId: number;
  since: number;
  now: number;
}

/** 主线程 -> Disk I/O Worker：按主键批量读取黑白名单，供两份 LRU 冷缺失预热。 */
export interface ReadIdentityPoliciesRequest {
  type: "readIdentityPolicies";
  requestId: number;
  ids: readonly number[];
}

/** 主线程 -> Disk I/O Worker：按需读取完整黑名单 ID，用于群级补扫。 */
export interface ReadBlocklistIdsRequest {
  type: "readBlocklistIds";
  requestId: number;
}

/**
 * 需要逐条回执的 main -> diskIO 请求信封。四条通道共用同一套发号、等待表与
 * 超时结算（见 infra/diskIO/host.ts 的 requestDiskIO），因此 requestId 是它们
 * 唯一必须共有的字段。
 */
export type DiskIORequestMessage =
  | EnsureLuckSecretRequest
  | ReadJoinLogRequest
  | ReadIdentityPoliciesRequest
  | ReadBlocklistIdsRequest;

export type DiskIOMessage =
  | DiskDiagnosticBatchRequest
  | AiMemoryDiskMessage
  | AiMemoryDeleteDiskMessage
  | AiMemoryForgetDiskMessage
  | StickerCatalogDiskMessage
  | LuckDrawDiskMessage
  | VerificationUpsertDiskMessage
  | VerificationDeleteDiskMessage
  | BlocklistRemovalsDiskMessage
  | IdentityPolicyWriteDiskMessage
  | JoinLogDiskMessage
  | EnsureLuckSecretRequest
  | ReadJoinLogRequest
  | ReadIdentityPoliciesRequest
  | ReadBlocklistIdsRequest
  | LoadRequest
  | RecoveryReplayRequest
  | DiskFlushRequest;

/** diskIOWorker -> 主线程：启动恢复读盘完成。两张快照表的值与增量写入
 * 消息同形态——序列化 JSON 文本（恢复时逐字段重建校验后重新 stringify，
 * 见 workers/diskIO/snapshotFiles.ts），供 hydrate 链路直接透传。 */
export interface LoadedReply {
  type: "loaded";
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
  /** 恢复失败时主线程必须拒绝启动，不能把部分结果当成空状态继续。 */
  error?: string;
}

/**
 * 启动恢复通过严格校验后交给应用生命周期的完整数据。AI 记忆与贴纸目录仍是
 * 已校验后重新序列化的 JSON 文本，hydrate 链路直接透传给对应 Worker。
 */
export interface LoadedData {
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  luckReceiptSecret: LuckReceiptSecret;
  verifications: Map<string, VerificationSnapshot>;
  pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
  blocklistEntryCount: number;
  whitelistEntryCount: number;
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

/** Disk I/O Worker -> 主线程：一次黑白名单批量读取的原始 JSON 文本。 */
export interface IdentityPoliciesReadReply {
  type: "identityPoliciesRead";
  requestId: number;
  whitelist?: readonly (readonly [number, string])[];
  blocklist?: readonly (readonly [number, string])[];
  error?: string;
}

/** Disk I/O Worker -> 主线程：群级补扫所需的完整黑名单 ID。 */
export interface BlocklistIdsReadReply {
  type: "blocklistIdsRead";
  requestId: number;
  ids?: readonly number[];
  error?: string;
}

/** 一项黑白名单最终值已由显式 SQLite 事务提交。 */
export interface IdentityPolicyPersistedRevision {
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly revision: number;
}

/** Disk I/O Worker -> 主线程：清理最终一致性重放缓冲的事务 ACK。 */
export interface IdentityStoragePersistedReply {
  type: "identityStoragePersisted";
  writes: readonly IdentityPolicyPersistedRevision[];
  /** 本事务覆盖到的最新待踢成员快照修订号。 */
  removalSnapshotRevision?: number;
}

/** Disk I/O Worker 在 SQLite 事务 durable 后发送精确 ACK 的线程内回调。 */
export type IdentityPersistenceReply = (
  reply: IdentityStoragePersistedReply
) => void;

/**
 * 统一 flush 覆盖的九个落盘领域。回执按领域拆开，是为了让「等自己这条记录
 * 落盘」的调用方（典型是 /block）不会因为无关领域失败而误报——那会把运维
 * 引向一个其实没坏的文件，而真正坏掉的领域按设计只有 console.error，
 * 永远进不了 logs/（见 workers/diskIOWorker.ts 的 flushAll）。
 */
export type DiskIODomain =
  | "log"
  | "aiMemory"
  | "stickerCatalog"
  | "luck"
  | "verification"
  | "whitelist"
  | "blocklist"
  | "blocklistRemovalOutbox"
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

/** diskIOWorker -> 主线程：flush 已完成，九个领域全部落盘。 */
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

export type DiskIOReply =
  | LoadedReply
  | DiskDiagnosticBatchAcceptedReply
  | DiskDiagnosticBatchRetryReply
  | RecoveryReplayFailedReply
  | LuckSecretReply
  | JoinLogReadReply
  | IdentityPoliciesReadReply
  | BlocklistIdsReadReply
  | IdentityStoragePersistedReply
  | DiskFlushReply
  | DiskFlushFailedReply
  | VerificationPersistedReply
  | AiMemoryPersistedReply
  | AiMemoryDeletedPersistedReply
  | LuckAppendStalledReply;
