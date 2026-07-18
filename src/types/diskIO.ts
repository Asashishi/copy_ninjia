/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI 记忆快照、每日运势快照三类落盘共用同一个 Worker。快照的结构
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
  /** 抽签发生时刻的东京日期（YYYY-MM-DD），由主线程算好带过来，见 commands/luckChallenge.ts。 */
  day: string;
  /** 缓存 key："<userId>" 或 "<userId>:<text>"，与 dailyLuckCache 的 key 一致。 */
  key: string;
  /** LuckTier.label；加载时按 LUCK_TIERS 反查还原 tier 本身（见 commands/luckChallenge.ts 的 restoreLuckCache）。 */
  label: string;
  /** 该次抽签在 tier.fortunePercentRange 内浮动出的行大运具体数值（%，两位小数）。
   * 不再能从 label 反查得出（区间是浮动的），必须随 label 一起落盘，见 LuckDrawRecord。 */
  fortunePercent: number;
}

/** 主线程 -> diskIOWorker：启动恢复（也用于本 Worker 崩溃重建后的自动重跑）。 */
export interface LoadRequest {
  type: "load";
}

/** 主线程 -> diskIOWorker：三类 dirty 数据全部立即落盘，随后回执。 */
export interface DiskFlushRequest {
  type: "flush";
  flushId: number;
}

export type DiskIOMessage = LogEnvelope | AiMemoryDiskMessage | AiMemoryDeleteDiskMessage | StickerCatalogDiskMessage | LuckDrawDiskMessage | LoadRequest | DiskFlushRequest;

/** 单条抽签结果的落盘/缓存形状：吉凶档 label + 该次浮动出的行大运概率。
 * fortunePercent 不再能从 label 反查得出（tier 的概率是区间浮动的，见
 * LuckTier.fortunePercentRange），必须两个字段一起存、一起载入。 */
export interface LuckDrawRecord {
  label: string;
  fortunePercent: number;
}

/** 当天的运势缓存：内存态（entries 是 Map）。落盘态是同形状的扁平对象，见 LuckDayFile。 */
export interface LuckDayCache {
  day: string;
  entries: Map<string, LuckDrawRecord>;
}

/** 追加写入某天文件时，一条尚未落盘的新记录（去重后才会进入这个缓冲，
 * 见 workers/diskIO/luckFiles.ts 的 handleLuckDrawMessage）。 */
export interface LuckPendingEntry {
  key: string;
  record: LuckDrawRecord;
}

/** diskIOWorker -> 主线程：启动恢复读盘完成。两张快照表的值与增量写入
 * 消息同形态——序列化 JSON 文本（恢复时逐字段重建校验后重新 stringify，
 * 见 workers/diskIO/snapshotFiles.ts），供 hydrate 链路直接透传。 */
export interface LoadedReply {
  type: "loaded";
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  /** 恢复失败时主线程必须拒绝启动，不能把部分结果当成空状态继续。 */
  error?: string;
}

/** diskIOWorker -> 主线程：flush 已完成。 */
export interface DiskFlushReply {
  type: "flushed";
  flushedId: number;
}

export type DiskIOReply = LoadedReply | DiskFlushReply;

/** 当前追加目标文件（日志或每日运势）的状态：字节大小用于定位结尾的
 * 「\n}」，供按位置追加，见 workers/diskIO/appendOnlyDayFile.ts。 */
export interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}

/**
 * memory/luck/YYYY-MM-DD.json 的落盘结构：顶层直接就是 entries 本身（key ->
 * LuckDrawRecord），不套 version/entries 包装——文件按位置追加写入
 * （见 workers/diskIO/appendOnlyDayFile.ts），顶层必须是扁平对象。加载时
 * 按 LUCK_TIERS 反查 label 还原成 LuckTier 对象，fortunePercent 原样带回、
 * 不重新滚动，见 workers/diskIO/snapshotFiles.ts 的 recoverLuckDay；结构不
 * 匹配的条目按对象结构校验丢弃、当天重抽，不做迁移——运势文件本就跨天
 * 即删，代价可忽略。
 */
export type LuckDayFile = Record<string, LuckDrawRecord>;
