/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。落盘
 * 线程（diskIOWorker）的创建、自愈、flush/load 握手统一由 infra/diskIO.ts
 * 管理——该 Worker 同时也是 AI 记忆快照的落盘线程，只由主线程
 * 启动这一个（若每个线程都自建落盘线程，多个实例按字节偏移并发追加同一个
 * 日志文件会互相踩踏写坏文件）。这里只是门面：主线程下 error 日志经
 * relayLogMessage 转投给它；Worker 线程里的 logger 处于「转发模式」：
 * error 日志包上 ForwardedLog 信封 postMessage 回主线程，由拥有该 Worker
 * 的主线程模块（见 aiChat.ts 的 onEvent）调用 relayLogMessage 转投唯一的
 * 落盘线程。
 */

import { relayLogMessage } from "./diskIO";
import type { ForwardedLog, LogLevel, LogMessage } from "../types";

declare var self: Worker;

// 是否运行在主线程：决定 error 日志是直接转投落盘线程，还是包上信封向上
// 转发给拥有本 Worker 的主线程模块。
const isMainThread: boolean = Bun.isMainThread;

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
  if (level !== "error") return;
  const message: LogMessage = {
    timestamp: Date.now(),
    level,
    args: args.map(serializeArg),
  };
  if (isMainThread) {
    relayLogMessage(message);
  } else {
    // 转发模式（本模块运行在某个 Worker 线程里）：发回主线程转投落盘线程。
    self.postMessage({ __log: message } satisfies ForwardedLog);
  }
}

export const logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
