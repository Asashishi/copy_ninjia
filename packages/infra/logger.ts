/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。落盘
 * 线程（diskIOWorker）的显式初始化、自愈、flush/load 握手统一由
 * infra/diskIO.ts 管理——入口取得 bot.lock 后才启动该 Worker。初始化前的 error
 * 只输出到 stderr，不会提前触碰共享 logs/。该 Worker 同时也是 AI 记忆快照的
 * 落盘线程，只由主线程启动这一个（若每个线程都自建落盘线程，多个实例按
 * 字节偏移并发追加同一个日志文件会互相踩踏写坏文件）。这里只是门面：主线程
 * 下 error 日志经 relayLogMessage 转投给它；Worker 线程里的 logger 处于「转发模式」：
 * error 日志经单批 ACK、有消息数与载荷字节硬顶的 ForwardedLogBatch 通道回主线程，由拥有该 Worker
 * 的主线程模块（见 aiChat/workerBridge.ts 与 antiRaid/workerBridge.ts 的 onEvent）调用 relayLogMessage 转投唯一的
 * 落盘线程。
 */

import { relayLogMessage } from "./diskIO";
import { serializeLogArgs } from "./logger/serialization";
import {
  acceptForwardedLogBatch as acceptForwardedLogBatchInternal,
  forwardWorkerLog,
} from "./logger/forwarding";
import type { ForwardedLogSink } from "./logger/forwarding";
import type {
  ForwardedLogBatch,
  LogLevel,
  LogMessage,
} from "../types/diskIO";

declare const self: Worker;

// 是否运行在主线程：决定 error 日志是直接转投落盘线程，还是包上信封向上
// 转发给拥有本 Worker 的主线程模块。
const isMainThread: boolean = Bun.isMainThread;

/**
 * Worker 侧转发出口。整条协议（有界队列、单批 ACK、溢出汇总）住在
 * infra/logger/forwarding.ts；这里只把它接到本 isolate 的 postMessage 上。
 * 拆开的理由见那个文件的头注：isMainThread 是加载期常量，协议留在本文件里
 * 就永远只能在真 Worker 里执行，测不到。
 */
const forwardToMainThread: ForwardedLogSink = (batch: ForwardedLogBatch): void => {
  self.postMessage(batch);
};

/**
 * 消费主线程发回的日志批次 ACK。返回 true 表示该消息属于 logger 协议，Worker
 * 入口不得再把它交给业务路由。
 */
export function acceptForwardedLogBatch(message: unknown): boolean {
  return acceptForwardedLogBatchInternal(message, forwardToMainThread);
}

function emit(level: LogLevel, args: unknown[]): void {
  // 序列化边界统一处理异常对象、不可序列化值与敏感字段。
  const serializedArgs: unknown[] = serializeLogArgs(args);
  // 所有控制台级别都可能被 journal 长期保存，统一输出脱敏后的参数；不能
  // 只保护 error 的 JSON 文件而让 info/warn 中未来新增的敏感值原样泄露。
  try {
    console[level](...serializedArgs);
  } catch {
    // console 可能在测试替身或宿主故障时拒绝；logger 的控制流仍必须保持 total。
  }
  if (level !== "error") return;
  const message: LogMessage = {
    timestamp: Date.now(),
    level,
    args: serializedArgs,
  };
  if (isMainThread) {
    relayLogMessage(message);
  } else {
    // 转发模式：先进入单批 ACK、有界待发送 FIFO，再由主线程转投落盘线程。
    forwardWorkerLog(message, forwardToMainThread);
  }
}

/** 主线程与 Worker 共用的日志出口；Worker 侧经 postMessage 转发到主线程。 */
interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export const logger: Logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
