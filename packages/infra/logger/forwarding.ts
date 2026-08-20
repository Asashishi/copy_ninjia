/**
 * 业务 Worker 侧 error 日志回主线程的有界转发通道。
 *
 * 从 infra/logger.ts 分出来的一层。那边是门面，按 `Bun.isMainThread` 在「直接转投
 * 落盘线程」与「包信封向上转发」之间二选一；而 isMainThread 是模块加载期定死的
 * 常量，于是整条 Worker 侧协议——单批在途、溢出计数、汇总补发、迟到/重复 ACK——
 * 在主线程跑的测试里一行都执行不到。抽到这里并把出口做成可注入的 sink 之后，
 * 这几条路径不再依赖「当前线程是谁」。
 *
 * 通道形状：任一时刻只有一个批次在途，主线程回 `__logBatchAccepted` 才推进下一批。
 * 总消息数与 JSON 载荷字节双硬顶（见 cache/perThread/logger.ts 的 forwardedLogQueue），
 * 越界的那条 error 已经写进本线程 stderr，这里只累计两个标量、不再持有对象引用，
 * 等队列排空后补一条汇总日志说明丢了多少。
 *
 * @see ../../../docs/cn/04-invariants.md
 */

import {
  forwardedLogDropState,
  forwardedLogQueue,
} from "../../cache/perThread/logger";
import { jsonSerializedBytes } from "../../libs/jsonBytes";
import { saturatingSafeIntegerAdd } from "../../libs/saturatingNumber";
import type { AcknowledgedBatch } from "../../libs/acknowledgedBatchQueue";
import type {
  ForwardedLogBatch,
  ForwardedLogBatchAccepted,
  LogMessage,
} from "../../types/diskIO";

/**
 * 批次的实际出口。生产是 Worker 的 `self.postMessage`（见 infra/logger.ts），
 * 允许抛出——同步拒绝由 pumpForwardedLogs 接住并保留原批等下次重试。
 */
export type ForwardedLogSink = (batch: ForwardedLogBatch) => void;

/** 没有在途批次时发送下一批；同步拒绝保留原批且不抛出。 */
export function pumpForwardedLogs(post: ForwardedLogSink): boolean {
  const batch: AcknowledgedBatch<LogMessage> | null = forwardedLogQueue.nextDelivery();
  if (batch === null) return true;
  const forwarded: ForwardedLogBatch = {
    __logBatch: {
      batchId: batch.batchId,
      messages: batch.values,
    },
  };
  try {
    post(forwarded);
    forwardedLogQueue.markDelivered(batch.batchId);
    return true;
  } catch {
    forwardedLogQueue.markDeliveryRejected();
    return false;
  }
}

/**
 * 主线程重新消费后，把 Worker 侧整段溢出收敛为一条可落盘的普通日志。
 * 只有汇总真的入了队才清零：入不进去说明队列仍然满着，计数必须留到下一次。
 *
 * `now` 只是测试缝：两个生产调用点都用缺省值，与拆分前逐字一致。**不要**改成
 * 从触发日志上取时刻——那会让同一条汇总按走哪条路径拿到两个不同的时间源，而
 * 这条路径本来就极少走，省一次读钟换不来任何东西。
 */
export function enqueueForwardedLogDropSummary(now: number = Date.now()): void {
  const dropState: typeof forwardedLogDropState.current =
    forwardedLogDropState.current;
  const droppedMessages: number = dropState.droppedMessages;
  if (droppedMessages === 0) return;
  const summary: LogMessage = {
    timestamp: now,
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
export function forwardWorkerLog(message: LogMessage, post: ForwardedLogSink): void {
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
  pumpForwardedLogs(post);
}

/**
 * 消费主线程发回的日志批次 ACK。返回 true 表示该消息属于 logger 协议，Worker
 * 入口不得再把它交给业务路由；迟到/重复 ACK 也视为已消费但不会推进错误批次。
 */
export function acceptForwardedLogBatch(message: unknown, post: ForwardedLogSink): boolean {
  if (message === null || typeof message !== "object" || !("__logBatchAccepted" in message)) {
    return false;
  }
  const accepted: ForwardedLogBatchAccepted = message as ForwardedLogBatchAccepted;
  if (
    typeof accepted.__logBatchAccepted === "number" &&
    forwardedLogQueue.acknowledge(accepted.__logBatchAccepted)
  ) {
    enqueueForwardedLogDropSummary();
    pumpForwardedLogs(post);
  }
  return true;
}
