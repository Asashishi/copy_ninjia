export type LogLevel = "log" | "info" | "warn" | "error";

/** 发给 worker 的消息结构：毫秒时间戳 + 级别 + 已序列化的参数列表。 */
export interface LogMessage {
  timestamp: number;
  level: LogLevel;
  args: unknown[];
}

/** 发给 worker 的落盘指令：要求立即 flush 内存 buffer 并回执。 */
export interface FlushRequest {
  flushId: number;
}

/** worker 完成 flush 后的回执。 */
export interface FlushReply {
  flushedId: number;
}

/** Worker 线程转发 error 日志回主线程时的信封（见 logger.ts 模块头注释的转发模式）。 */
export interface ForwardedLog {
  __log: LogMessage;
}

/** 当前追加目标日志文件的状态：字节大小用于定位结尾的「\n}」（见 workers/loggerWorker.ts）。 */
export interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}
