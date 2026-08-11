import {
  LOGGER_FORWARD_BATCH_MAX_MESSAGES,
  LOGGER_FORWARD_MAX_PENDING_MESSAGES,
  LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
} from "../../consts/logger";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import type { LogMessage } from "../../types/diskIO";

/**
 * owner：每个业务 Worker isolate。
 *
 * logger.error 填充，主线程的 __logBatchAccepted 回执逐批排空；整个 Worker
 * isolate 销毁后随堆释放，重建 isolate 从空队列开始。
 * 单批在途并保留到 ACK；总消息数与 JSON 载荷字节有硬顶。越界 error 已经写入
 * 本线程 stderr，不再保留对象引用，只累计两个标量；主线程恢复消费后补发一条
 * 汇总日志。本线程同步投递拒绝后由后续日志触发原批重试。
 */
export const forwardedLogQueue: AcknowledgedBatchQueue<LogMessage> =
  new AcknowledgedBatchQueue<LogMessage>({
    maxBatchMessages: LOGGER_FORWARD_BATCH_MAX_MESSAGES,
    maxMessages: LOGGER_FORWARD_MAX_PENDING_MESSAGES,
    maxCost: LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
  });

/**
 * owner：每个业务 Worker isolate。转发队列溢出时累计，汇总成功入队后清零；
 * isolate 销毁时随堆释放。容量恒为两个 number，不随错误数量增长。
 */
export const forwardedLogDropState: {
  current: {
    droppedMessages: number;
    droppedSerializedBytes: number;
  };
} = {
  current: {
    droppedMessages: 0,
    droppedSerializedBytes: 0,
  },
};
