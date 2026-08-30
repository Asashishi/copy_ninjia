import type { AdSampleMessage } from "../antiRaid/adDetect";
import type { VerificationSnapshot } from "../antiRaid/verification";
import type { PendingBlockedRemoval } from "../blocklist";
import type { IdentityPolicyTable } from "../identityPolicy";
import type { TemporaryWhitelistActivity } from "../temporaryWhitelist";
import type { LuckReceiptSecret } from "./storage";

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

/** 主线程 -> Disk I/O Worker：一项临时白名单累计最终值；null 表示删除。 */
export interface TemporaryWhitelistWriteDiskMessage {
  type: "temporaryWhitelistWrite";
  id: number;
  activity: Readonly<TemporaryWhitelistActivity> | null;
  /** 主线程同一身份累计行的单调修订号。 */
  revision: number;
}

/** 主线程 -> Disk I/O Worker：一群最终状态；null 表示删除该主键。 */
export interface ChatStateWriteDiskMessage {
  type: "chatStateWrite";
  chatId: number;
  data: string | null;
  /** 主线程群状态写入的单调修订号。 */
  revision: number;
}

/**
 * 主线程 -> Disk I/O Worker：一条群问答最终值；`data` 为 null 表示删除这条问答。
 *
 * 主键是 (chatId, q) 复合键，因此两者都要随消息过去；`q` 由主线程 trim 后作为
 * 落库主键，Worker 不再做归一化——两侧对同一条问答必须指的是同一个键。
 */
export interface ChatQaWriteDiskMessage {
  type: "chatQaWrite";
  chatId: number;
  q: string;
  data: string | null;
  /** 主线程问答写入的单调修订号。 */
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
  | TemporaryWhitelistWriteDiskMessage
  | ChatStateWriteDiskMessage
  | ChatQaWriteDiskMessage
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

/** 主线程 -> Disk I/O Worker：按主键批量读取身份策略，供三份 LRU 冷缺失预热。 */
export interface ReadIdentityPoliciesRequest {
  type: "readIdentityPolicies";
  requestId: number;
  ids: readonly number[];
}

/** 主线程 -> Disk I/O Worker：按稳定主键游标读取一页黑名单 ID。 */
export interface ReadBlocklistIdPageRequest {
  type: "readBlocklistIdPage";
  requestId: number;
  /** null 从最小主键开始；其余值只读取严格大于该主键的行。 */
  afterId: number | null;
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
  | ReadBlocklistIdPageRequest;

/**
 * 落盘线程 mailbox 收得到的全部消息 = 诊断 + 业务 + 逐条回执请求 + 生命周期。
 *
 * 前两组直接复用 DiskBusinessMessage 与 DiskIORequestMessage；新增消息必须先归入
 * 对应领域联合类型，路由与可重放清单由同一事实源展开。
 */
export type DiskIOMessage =
  | DiskDiagnosticBatchRequest
  | DiskBusinessMessage
  | DiskIORequestMessage
  | LoadRequest
  | RecoveryReplayRequest
  | DiskFlushRequest;
