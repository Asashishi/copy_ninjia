import { LOGGER_FORWARD_BATCH_MAX_MESSAGES } from "../../consts/logger";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import type { LogMessage } from "../../types/diskIO";

/**
 * owner：每个业务 Worker isolate。
 *
 * logger.error 填充，主线程的 __logBatchAccepted 回执逐批排空；整个 Worker
 * isolate 销毁后随堆释放，重建 isolate 从空队列开始。
 * 单批在途并保留到 ACK；待发送 FIFO 刻意不设容量：本项目是约 15 个群的
 * 单租户部署，日志转发消费速度显著高于 Telegram 事件生产速度，进程内不主动
 * 丢弃优先于理论故障下的内存硬顶。主线程同步拒收后由后续日志触发原批重试。
 */
export const forwardedLogQueue: AcknowledgedBatchQueue<LogMessage> =
  new AcknowledgedBatchQueue<LogMessage>(LOGGER_FORWARD_BATCH_MAX_MESSAGES);
