import type { VerificationSnapshot } from "./antiRaid";
import type { LuckDayCache, LuckReceiptSecret } from "./diskIO/storage";
export type * from "./diskIO/storage";

/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI/贴纸快照、每日运势与待验证当日增量共用同一个 Worker。快照的结构
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
  snapshot: string;
}

/** 主线程 -> diskIOWorker：彻底删除某群 AI 记忆快照。 */
export interface AiMemoryDeleteDiskMessage {
  type: "deleteAiMemory";
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

export type DiskIOMessage =
  | LogEnvelope
  | AiMemoryDiskMessage
  | AiMemoryDeleteDiskMessage
  | StickerCatalogDiskMessage
  | LuckDrawDiskMessage
  | VerificationUpsertDiskMessage
  | VerificationDeleteDiskMessage
  | EnsureLuckSecretRequest
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
  /** 恢复失败时主线程必须拒绝启动，不能把部分结果当成空状态继续。 */
  error?: string;
}

/** ensureLuckSecret 的逐请求回执；失败时不返回密钥，主线程不得继续抽签。 */
export interface LuckSecretReply {
  type: "luckSecret";
  requestId: number;
  secret?: LuckReceiptSecret;
  error?: string;
}

/** diskIOWorker -> 主线程：flush 已完成。 */
export interface DiskFlushReply {
  type: "flushed";
  flushedId: number;
}

/** diskIOWorker -> 主线程：至少一个领域仍 dirty 或本轮写入失败。 */
export interface DiskFlushFailedReply {
  type: "flushFailed";
  flushedId: number;
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

export type DiskIOReply = LoadedReply | LuckSecretReply | DiskFlushReply | DiskFlushFailedReply | VerificationPersistedReply;
