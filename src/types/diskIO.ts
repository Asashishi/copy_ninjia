import type { AiMemorySnapshot } from "./aiChat";

/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）统一的消息协议与快照类型：
 * 日志、AI 记忆快照两类落盘共用同一个 Worker。
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

/** 主线程 -> diskIOWorker：启动恢复（也用于本 Worker 崩溃重建后的自动重跑）。 */
export interface LoadRequest {
  type: "load";
}

/** 主线程 -> diskIOWorker：两类 dirty 数据全部立即落盘，随后回执。 */
export interface DiskFlushRequest {
  type: "flush";
  flushId: number;
}

export type DiskIOMessage = LogEnvelope | AiMemoryDiskMessage | LoadRequest | DiskFlushRequest;

/** diskIOWorker -> 主线程：启动恢复读盘完成。 */
export interface LoadedReply {
  type: "loaded";
  aiMemories: Map<number, AiMemorySnapshot>;
}

/** diskIOWorker -> 主线程：flush 已完成。 */
export interface DiskFlushReply {
  type: "flushed";
  flushedId: number;
}

export type DiskIOReply = LoadedReply | DiskFlushReply;

/** 当前追加目标文件（日志）的状态：字节大小用于定位结尾的「\n}」，供按
 * 位置追加，见 workers/diskIO/appendOnlyDayFile.ts。 */
export interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}
