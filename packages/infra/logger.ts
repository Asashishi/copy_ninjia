/**
 * 统一日志门面，替代散落各处的 console.*。所有级别照常输出到控制台
 * （由 systemd journal 收集）；error 级别额外发给独立的 Bun Worker 线程
 * 落盘到 logs/ 目录，按日一个 JSON 文件，避免文件 IO 阻塞主线程的
 * 消息处理循环。
 *
 * 本模块可能同时被主线程和其它 Bun Worker（如 aiChatWorker）import。落盘
 * 线程（diskIOWorker）的显式初始化、自愈、flush/load 握手统一由
 * infra/diskIO.ts 管理——入口取得 bot.lock 后才启动该 Worker。此前的 error
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
  forwardedLogDropState,
  forwardedLogQueue,
} from "../cache/perThread/logger";
import type {
  ForwardedLogBatch,
  ForwardedLogBatchAccepted,
  LogLevel,
  LogMessage,
} from "../types/diskIO";
import type { AcknowledgedBatch } from "../libs/acknowledgedBatchQueue";
import { jsonSerializedBytes } from "../libs/jsonBytes";
import { saturatingSafeIntegerAdd } from "../libs/saturatingNumber";

declare const self: Worker;

// 是否运行在主线程：决定 error 日志是直接转投落盘线程，还是包上信封向上
// 转发给拥有本 Worker 的主线程模块。
const isMainThread: boolean = Bun.isMainThread;

/** Worker 转发通道没有在途批次时发送下一批；同步拒绝保留原批且不抛出。 */
function pumpForwardedLogs(): boolean {
  const batch: AcknowledgedBatch<LogMessage> | null = forwardedLogQueue.nextDelivery();
  if (batch === null) return true;
  const forwarded: ForwardedLogBatch = {
    __logBatch: {
      batchId: batch.batchId,
      messages: batch.values,
    },
  };
  try {
    self.postMessage(forwarded);
    forwardedLogQueue.markDelivered(batch.batchId);
    return true;
  } catch {
    forwardedLogQueue.markDeliveryRejected();
    return false;
  }
}

/** 主线程重新消费后，把 Worker 侧整段溢出收敛为一条可落盘的普通日志。 */
function enqueueForwardedLogDropSummary(): void {
  const dropState: typeof forwardedLogDropState.current =
    forwardedLogDropState.current;
  const droppedMessages: number = dropState.droppedMessages;
  if (droppedMessages === 0) return;
  const summary: LogMessage = {
    timestamp: Date.now(),
    level: "error",
    args: [
      `[logger] dropped ${droppedMessages} Worker error log(s) totaling ` +
      `${dropState.droppedSerializedBytes} serialized byte(s) after ` +
      "the forwarding queue reached its hard limits.",
    ],
  };
  if (!forwardedLogQueue.enqueue(summary, jsonSerializedBytes(summary))) return;
  dropState.droppedMessages = 0;
  dropState.droppedSerializedBytes = 0;
}

/** Worker error 日志进入有界转发队列；主线程不调用这条路径。 */
function forwardWorkerLog(message: LogMessage): void {
  enqueueForwardedLogDropSummary();
  const serializedBytes: number = jsonSerializedBytes(message);
  if (!forwardedLogQueue.enqueue(message, serializedBytes)) {
    const dropState: typeof forwardedLogDropState.current =
      forwardedLogDropState.current;
    dropState.droppedMessages = saturatingSafeIntegerAdd(
      dropState.droppedMessages,
      1
    );
    dropState.droppedSerializedBytes = saturatingSafeIntegerAdd(
      dropState.droppedSerializedBytes,
      serializedBytes
    );
  }
  pumpForwardedLogs();
}

/**
 * 消费主线程发回的日志批次 ACK。返回 true 表示该消息属于 logger 协议，Worker
 * 入口不得再把它交给业务路由；迟到/重复 ACK 也视为已消费但不会推进错误批次。
 */
export function acceptForwardedLogBatch(message: unknown): boolean {
  if (message === null || typeof message !== "object" || !("__logBatchAccepted" in message)) {
    return false;
  }
  const accepted: ForwardedLogBatchAccepted = message as ForwardedLogBatchAccepted;
  if (
    typeof accepted.__logBatchAccepted === "number" &&
    forwardedLogQueue.acknowledge(accepted.__logBatchAccepted)
  ) {
    enqueueForwardedLogDropSummary();
    pumpForwardedLogs();
  }
  return true;
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
    forwardWorkerLog(message);
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
