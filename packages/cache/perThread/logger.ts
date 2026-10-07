/** owner: perThread。 */

import {
  LOGGER_FORWARD_BATCH_MAX_MESSAGES,
  LOGGER_FORWARD_MAX_PENDING_MESSAGES,
  LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
} from "../../consts/logger";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import type { LogMessage } from "../../types/diskIO/messages";
import type { LoggerSecretsSnapshot } from "../../types/logger";

/**
 * 持有方：每个业务 Worker isolate。
 *
 * logger.error 填充，主线程的 __logBatchAccepted 回执逐批排空；整个 Worker
 * isolate 销毁后随堆释放，重建 isolate 从空队列开始。
 * 单批在途并保留到 ACK；总消息数与 JSON 载荷字节有硬顶。越界 error 已经写入
 * 本线程 stderr，不再保留对象引用，只累计丢弃条数与字节数；主线程恢复消费后补发一条
 * 汇总日志。本线程同步投递拒绝后由后续日志触发原批重试。
 */
export const forwardedLogQueue: AcknowledgedBatchQueue<LogMessage> =
  new AcknowledgedBatchQueue<LogMessage>({
    maxBatchMessages: LOGGER_FORWARD_BATCH_MAX_MESSAGES,
    maxMessages: LOGGER_FORWARD_MAX_PENDING_MESSAGES,
    maxCost: LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
  });

/**
 * 持有方：每个业务 Worker isolate。转发队列溢出时累计，汇总成功入队后清零；
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

/**
 * 每条线程各持一份（同 cache/perThread/config.ts 的各凭据 holder）。
 *
 * `infra/logger/serialization.ts` 的 currentSecrets 按各配置 holder 的对象身份缓存
 * 文本凭据、JSON 转义片段与遍历回调；配置在启动与 config/dynamic/ 热重载时整体替换。
 * 首次使用或任一配置身份变化时一次构造完整快照，再替换 current；配置未变时复用
 * 快照。当前凭据排在退役凭据之前，上一份快照里不再生效的旧凭据继续保留。
 *
 * 容量恒为一个快照对象、一个回调与两份最多 LOGGER_MAX_REDACTED_SECRETS 项的只读数组，没有
 * 单独的清理时机：快照只在身份变化时整体替换，超出上限时丢弃最早退役的旧凭据。
 * Worker 崩溃或线程重建后 current 归 null，下一条日志按当时的配置 holder 重建。
 */
export const loggerSecretsMemo: {
  current: LoggerSecretsSnapshot | null;
} = { current: null };

/**
 * 主线程 error 日志的落盘出口：infra/diskIO.ts 的 initDiskIO 装上 relayLogMessage，之后不清除
 * （落盘线程终止后 relayLogMessage 自行返回 false）。
 *
 * 只有主线程会装；业务 Worker 与 Disk I/O Worker 里保持 null，infra/logger.ts 在 Worker 里走
 * 转发模式，不读它。主线程装上之前的 error 只写 stderr，与落盘线程初始化前相同。容量恒为
 * 一个函数；进程退出随堆释放。
 */
export const logRelaySink: { current: ((message: LogMessage) => boolean) | null } = { current: null };
