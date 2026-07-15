import type { AiMemorySnapshot } from "./aiChat";

/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI 记忆快照、每日运势快照三类落盘共用同一个 Worker。
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

/** 主线程 -> diskIOWorker：覆盖式写入某群的 AI 记忆快照。 */
export interface AiMemoryDiskMessage {
  type: "aiMemory";
  chatId: number;
  snapshot: AiMemorySnapshot;
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

export type DiskIOMessage = LogEnvelope | AiMemoryDiskMessage | LuckDrawDiskMessage | LoadRequest | DiskFlushRequest;

/** 单条抽签结果的落盘/缓存形状：吉凶档 label + 该次浮动出的行大运概率。
 * fortunePercent 不再能从 label 反查得出（tier 的概率是区间浮动的，见
 * LuckTier.fortunePercentRange），必须两个字段一起存、一起载入。 */
export interface LuckDrawRecord {
  label: string;
  fortunePercent: number;
}

/** 当天的运势缓存：内存态（entries 是 Map）。落盘态 entries 是普通对象，见 LuckDayFile。 */
export interface LuckDayCache {
  day: string;
  entries: Map<string, LuckDrawRecord>;
}

/** diskIOWorker -> 主线程：启动恢复读盘完成。 */
export interface LoadedReply {
  type: "loaded";
  aiMemories: Map<number, AiMemorySnapshot>;
  luckDay: LuckDayCache | null;
}

/** diskIOWorker -> 主线程：flush 已完成。 */
export interface DiskFlushReply {
  type: "flushed";
  flushedId: number;
}

export type DiskIOReply = LoadedReply | DiskFlushReply;

/** 当前追加目标日志文件的状态：字节大小用于定位结尾的「\n}」（见 workers/diskIO/logFiles.ts）。 */
export interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}

/**
 * memory/luck/YYYY-MM-DD.json 的落盘结构：entries 的 value 是 LuckDrawRecord
 * （label + fortunePercent），加载时按 LUCK_TIERS 反查 label 还原成 LuckTier 对象，
 * fortunePercent 原样带回、不重新滚动。version 2：新增 fortunePercent 字段（version 1
 * 时 entries 的 value 是纯 label 字符串，结构不兼容；见 workers/diskIO/snapshotFiles.ts
 * 的 recoverLuckDay 按对象结构校验，旧格式条目会被判定不匹配而丢弃，当天重抽，
 * 不做迁移——运势文件本就跨天即删，代价可忽略）。
 */
export interface LuckDayFile {
  version: 2;
  entries: Record<string, LuckDrawRecord>;
}
