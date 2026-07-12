/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。
 * 落盘线程（loggerWorker）只由主线程启动这一个——若每个线程都自建落盘
 * 线程，多个实例按字节偏移并发追加同一个日志文件会互相踩踏写坏文件。
 * Worker 线程里的 logger 因此处于「转发模式」：error 日志包上 ForwardedLog
 * 信封 postMessage 回主线程，由拥有该 Worker 的主线程模块（见 aiChat.ts
 * 的 onmessage）调用 relayLogMessage 转投唯一的落盘线程。
 */

import { pendingFlushes } from "./cache/logger";

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

/** Worker 线程转发 error 日志回主线程时的信封（见模块头注释的转发模式）。 */
export interface ForwardedLog {
  __log: LogMessage;
}

declare var self: Worker;

// 落盘 Worker 只在主线程、模块加载时启动一次；Worker 线程里为 null，
// 走转发模式。unref 让它不阻止进程退出：bot 主循环结束后进程照常退出，
// 不会被空闲的日志线程挂住。
const diskWorker: Worker | null = Bun.isMainThread
  ? new Worker(new URL("./loggerWorker.ts", import.meta.url).href)
  : null;
diskWorker?.unref();

// flushLogs 的回执 id 分配（路由表见 cache/logger.ts 的 pendingFlushes）。
// postMessage 按 FIFO 送达，flush 指令一定在它之前的日志消息都入队后才被
// 处理，回执即代表已落盘。
let nextFlushId: number = 1;

if (diskWorker) {
  diskWorker.onmessage = (event: MessageEvent<FlushReply>) => {
    const resolve = pendingFlushes.get(event.data.flushedId);
    if (resolve) {
      pendingFlushes.delete(event.data.flushedId);
      resolve();
    }
  };
}

/**
 * 把其它 Worker 线程转发来的 error 日志转投落盘线程。仅主线程调用——
 * 由拥有对应 Worker 的模块在 onmessage 里识别 ForwardedLog 信封后调用。
 */
export function relayLogMessage(message: LogMessage): void {
  diskWorker?.postMessage(message);
}

/**
 * 要求日志线程立即把内存 buffer 落盘，并等待完成。用于进程退出前的
 * 最后一刷，保证停留在 buffer 里（最长一分钟）的日志不随进程丢失。
 * 带超时兜底：worker 异常时停机流程最多被拖住 timeoutMs，不会挂死。
 * Worker 线程里没有本地落盘 buffer（日志都已转发出去），直接完成。
 */
export function flushLogs(timeoutMs: number = 3000): Promise<void> {
  if (!diskWorker) return Promise.resolve();
  return new Promise((resolve) => {
    const id: number = nextFlushId++;
    const timer = setTimeout(() => {
      pendingFlushes.delete(id);
      resolve();
    }, timeoutMs);
    pendingFlushes.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    const request: FlushRequest = { flushId: id };
    diskWorker.postMessage(request);
  });
}

/**
 * 把任意日志参数转成可 JSON 序列化的值。Error（含 GrammyError 等子类）
 * 展开为 name/message/stack 加自有可枚举属性；其余对象尝试 JSON 序列化，
 * 失败（循环引用等）则退化为字符串。
 */
function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
      ...JSON.parse(safeStringify({ ...arg })),
    };
  }
  if (arg === null || typeof arg !== "object") {
    return arg;
  }
  return JSON.parse(safeStringify(arg));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

function emit(level: LogLevel, args: unknown[]): void {
  console[level](...args);
  if (level === "error") {
    const message: LogMessage = {
      timestamp: Date.now(),
      level,
      args: args.map(serializeArg),
    };
    if (diskWorker) {
      diskWorker.postMessage(message);
    } else {
      // 转发模式（本模块运行在某个 Worker 线程里）：发回主线程转投落盘线程。
      self.postMessage({ __log: message } satisfies ForwardedLog);
    }
  }
}

export const logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
