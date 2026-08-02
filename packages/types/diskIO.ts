import type { AdSampleMessage, VerificationSnapshot } from "./antiRaid";
import type { PendingBlockedRemoval } from "./blocklist";
import type { FlushResult } from "./lifecycle";
import type {
  BlockedUserRecord,
  JoinLogRecord,
  LuckDayCache,
  LuckReceiptSecret,
} from "./diskIO/storage";
export type * from "./diskIO/storage";

/**
 * 磁盘 IO 线程（packages/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI/贴纸快照、每日运势、待验证当日增量与 /block 黑名单共用同一个
 * Worker。快照的结构
 * 类型（AiMemorySnapshot/StickerCatalogSnapshot）见 types/aiChat.ts——
 * 消息里只带它们序列化后的 JSON 文本。
 */

export type LogLevel = "log" | "info" | "warn" | "error";

/** 一条日志的内容（不含 type 标；也是 ForwardedLog 转发信封内层的形状）。 */
export interface LogMessage {
  timestamp: number;
  level: LogLevel;
  args: unknown[];
}

/** Worker 线程转发 error 日志回主线程时的信封（logger.ts 的转发模式，机制不变）。 */
export interface ForwardedLog {
  __log: LogMessage;
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

/**
 * 主线程 -> diskIOWorker：把一个 id 追加进黑名单文件。拉黑是低频且关键的
 * 操作，落盘端收到即写、不进合并窗口，见 workers/diskIO/blocklistFile.ts。
 */
export interface BlockUserDiskMessage {
  type: "blockUser";
  userId: number;
  /** 拉黑时刻的东京时间「YYYY/MM/DD HH:mm:ss」，由主线程算好带过来。 */
  blockedAt: string;
}

/**
 * 主线程 -> diskIOWorker：解除拉黑。带的是**删除之后的完整名单**而不是被删的
 * 那个 id：黑名单文件是追加型的，删不掉已有条目，唯一的办法是整文件重写，
 * 而重写的内容只能来自主线程那份权威内存 Map（见 infra/blocklist/）。
 */
export interface UnblockUserDiskMessage {
  type: "unblockUser";
  /**
   * 本次被解除的 id，仅供排查。Worker 重建后的整份重写没有「某一个 id」可言
   * （它补的是整表差异），那种场景下不带。
   */
  userId?: number;
  /** 重写后的完整名单，落盘端按它整文件重写。 */
  blocked: readonly (readonly [number, BlockedUserRecord])[];
}

/** 主线程 -> diskIOWorker：覆盖式写入尚未完成的黑名单成员移除 outbox。 */
export interface BlocklistRemovalsDiskMessage {
  type: "blocklistRemovals";
  removals: readonly (readonly [number, PendingBlockedRemoval])[];
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
  | StickerCatalogDiskMessage
  | LuckDrawDiskMessage
  | VerificationUpsertDiskMessage
  | VerificationDeleteDiskMessage
  | BlockUserDiskMessage
  | UnblockUserDiskMessage
  | BlocklistRemovalsDiskMessage
  | AdSampleDiskMessage
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

/** 主线程跨东京日期后要求唯一 Disk I/O Worker 加载或原子轮换日级密钥。 */
export interface EnsureLuckSecretRequest {
  type: "ensureLuckSecret";
  requestId: number;
  day: string;
}

/** 主线程 -> diskIOWorker：所有 dirty 持久化领域全部立即落盘，随后回执。 */
export interface DiskFlushRequest {
  type: "flush";
  flushId: number;
}

/** 主线程 -> diskIOWorker：按命令读取本群指定滚动时间窗内的入群记录。 */
export interface ReadJoinLogRequest {
  type: "readJoinLog";
  requestId: number;
  chatId: number;
  since: number;
  now: number;
}

export type DiskIOMessage =
  | LogEnvelope
  | AiMemoryDiskMessage
  | AiMemoryDeleteDiskMessage
  | StickerCatalogDiskMessage
  | LuckDrawDiskMessage
  | VerificationUpsertDiskMessage
  | VerificationDeleteDiskMessage
  | BlockUserDiskMessage
  | UnblockUserDiskMessage
  | BlocklistRemovalsDiskMessage
  | AdSampleDiskMessage
  | JoinLogDiskMessage
  | EnsureLuckSecretRequest
  | ReadJoinLogRequest
  | LoadRequest
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
  /**
   * /block 黑名单：key 为用户 id，value 是文件里那条完整记录。带上 blockedAt
   * 而不只是「在不在」，是因为 /unblock 要把主线程内存 Map 整份重写回文件
   * ——只读回 true 的话，重写会把所有人的拉黑时刻抹平（见 infra/blocklist/）。
   */
  blockedUsers: Map<number, BlockedUserRecord>;
  /** 未完成的黑名单成员移除 outbox；主线程过滤后在 Anti-Raid 初始化时重放。 */
  pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
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
  blockedUsers: Map<number, BlockedUserRecord>;
  pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
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

/**
 * 统一 flush 覆盖的八个落盘领域。回执按领域拆开，是为了让「等自己这条记录
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

/** diskIOWorker -> 主线程：flush 已完成，八个领域全部落盘。 */
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

export type DiskIOReply =
  | LoadedReply
  | LuckSecretReply
  | JoinLogReadReply
  | DiskFlushReply
  | DiskFlushFailedReply
  | VerificationPersistedReply
  | AiMemoryPersistedReply
  | AiMemoryDeletedPersistedReply;
