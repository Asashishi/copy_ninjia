import {
  LOGGER_FORWARD_BATCH_MAX_MESSAGES,
  LOGGER_FORWARD_MAX_PENDING_MESSAGES,
  LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
} from "../../consts/logger";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import type { LogMessage } from "../../types/diskIO";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  TelegramConfig,
} from "../../types/config";

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

/**
 * owner：每条线程各持一份（同 cache/perThread/config.ts 的三个凭据 holder）。
 *
 * `infra/logger/serialization.ts` 的 currentSecrets 每条日志都要把当前凭据摊成
 * 一个数组交给值级脱敏；那三份配置一个进程只有一代（见 docs/cn/04-invariants.md
 * 的「同一进程内只有一代 AI 配置」），逐条重建纯属白付。这里缓存上一次的结果，
 * **并连同它依据的三个 holder 取值一起记下来**：判据是对象身份，不是「已经算过
 * 一次」——三个 holder 都是惰性填充的，先记一次空结果就把「配置还没读完」固化成
 * 「这个进程没有凭据」，此后每条日志都不再脱敏。三处填充点（config/agent.ts 的
 * 启动总闸与两个测试替身入口、config/telegram.ts 的 `??=`）都是整体替换、绝不
 * 就地改写，因此身份变了就一定要重算，身份没变就一定还是同一份凭据。
 *
 * 容量恒为一个对象加一个最多 6 项的只读数组，因此没有单独的清理时机：四格只在
 * 身份变化时整体替换，不回收也不增长。Worker 崩溃或线程重建后从初始值起步，
 * 而初始的三个 null 与「三个 holder 都还没填」是同一件事——那时结果本来就是空数组，
 * 下一条日志会照常按当时的 holder 重算。
 */
export const loggerSecretsMemo: {
  telegram: TelegramConfig | null;
  adDetect: AdDetectAgentConfig | null;
  agent: AgentDeploymentConfig | null;
  value: readonly string[];
} = { telegram: null, adDetect: null, agent: null, value: [] };
