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
  /** LuckTier.label，只存这个，加载时按 LUCK_TIERS 反查还原（见 commands/luckChallenge.ts 的 restoreLuckCache）。 */
  label: string;
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

/** 当天的运势缓存：内存态（entries 是 Map）。落盘态 entries 是普通对象，见 LuckDayFile。 */
export interface LuckDayCache {
  day: string;
  entries: Map<string, string>;
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

/** memory/luck/YYYY-MM-DD.json 的落盘结构：只存 tier 的 label，加载时按 LUCK_TIERS 反查还原成 LuckTier 对象。 */
export interface LuckDayFile {
  version: 1;
  entries: Record<string, string>;
}
