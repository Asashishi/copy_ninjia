import { availableParallelism, totalmem } from "node:os";
import {
  BOT_STATUS_MICROSECONDS_PER_SECOND,
  BOT_STATUS_PERCENT_SCALE,
} from "../consts/botStatus";
import type { BotProcessStatus } from "../types/botStatus";

/** calculateBotProcessStatus 的原始采样输入。 */
export interface CalculateBotProcessStatusOptions {
  readonly uptimeSeconds: number;
  readonly cpuUserMicroseconds: number;
  readonly cpuSystemMicroseconds: number;
  readonly availableCpuCount: number;
  readonly rssBytes: number;
  readonly constrainedMemoryBytes: number;
  readonly totalMemoryBytes: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 把一次同步采样换算成稳定、有限的展示值。CPU 使用运行期累计值而非伪造瞬时值；
 * 多 Worker 消耗按可用逻辑核归一，因此结果表达整台可用算力中的平均份额。
 */
export function calculateBotProcessStatus({
  uptimeSeconds,
  cpuUserMicroseconds,
  cpuSystemMicroseconds,
  availableCpuCount,
  rssBytes,
  constrainedMemoryBytes,
  totalMemoryBytes,
}: CalculateBotProcessStatusOptions): BotProcessStatus {
  const safeUptimeSeconds: number = finiteNonNegative(uptimeSeconds);
  const safeCpuCount: number = Math.max(1, Math.floor(finiteNonNegative(availableCpuCount)));
  const cpuMicroseconds: number = finiteNonNegative(cpuUserMicroseconds) +
    finiteNonNegative(cpuSystemMicroseconds);
  const elapsedCpuCapacity: number = safeUptimeSeconds *
    BOT_STATUS_MICROSECONDS_PER_SECOND * safeCpuCount;
  const averageCpuPercent: number = elapsedCpuCapacity === 0
    ? 0
    : Math.min(
      BOT_STATUS_PERCENT_SCALE,
      cpuMicroseconds / elapsedCpuCapacity * BOT_STATUS_PERCENT_SCALE
    );
  const safeRssBytes: number = finiteNonNegative(rssBytes);
  const constrainedBytes: number = finiteNonNegative(constrainedMemoryBytes);
  const memoryLimitBytes: number = constrainedBytes > 0
    ? constrainedBytes
    : finiteNonNegative(totalMemoryBytes);
  const memoryPercent: number = memoryLimitBytes === 0
    ? 0
    : safeRssBytes / memoryLimitBytes * BOT_STATUS_PERCENT_SCALE;
  return {
    uptimeSeconds: safeUptimeSeconds,
    averageCpuPercent,
    availableCpuCount: safeCpuCount,
    rssBytes: safeRssBytes,
    memoryLimitBytes,
    memoryPercent,
  };
}

/** 同步读取当前 Bot 进程指标；不创建 timer、缓存或后台采样任务。 */
export function readBotProcessStatus(): BotProcessStatus {
  const cpuUsage: NodeJS.CpuUsage = process.cpuUsage();
  return calculateBotProcessStatus({
    uptimeSeconds: process.uptime(),
    cpuUserMicroseconds: cpuUsage.user,
    cpuSystemMicroseconds: cpuUsage.system,
    availableCpuCount: availableParallelism(),
    rssBytes: process.memoryUsage.rss(),
    constrainedMemoryBytes: process.constrainedMemory(),
    totalMemoryBytes: totalmem(),
  });
}
