/**
 * AI 模型请求的配额 lane：按供应商协议、端点与凭据识别真实配额归属，每条 lane 一个
 * 交互优先的有界执行器。lane 表在 cache/workers/aiChat/providerScheduler.ts；能力门面
 * （aiChat/provider.ts）构造时取 lane，agent 配置热重载后由 pruneQuotaLanes 摘除不再
 * 被引用的 lane。
 */

import { aiProviderQuotaLanes } from "../cache/workers/aiChat/providerScheduler";
import {
  AI_PROVIDER_BACKGROUND_MAX_PENDING,
  AI_PROVIDER_INTERACTIVE_BURST,
  AI_PROVIDER_MAX_CONCURRENT,
  AI_PROVIDER_MAX_PENDING,
} from "../consts/aiChat/provider";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { AgentDeploymentConfig } from "../types/config";
import type { AiProviderQuotaLane } from "../types/aiChat/providerScheduler";

/** 配额归属只看的三项：供应商协议、端点与凭据；各能力配置（含 xai 语音协议）都带这三项。 */
type QuotaLaneIdentity = Pick<AiProviderQuotaLane, "provider" | "baseUrl" | "apiKey">;

/** 以供应商协议、端点与凭据识别配额归属；模型名不参与，同一端点与凭据下的各模型共用一条 lane。 */
function isQuotaLaneOf(lane: AiProviderQuotaLane, config: QuotaLaneIdentity): boolean {
  return lane.provider === config.provider &&
    lane.baseUrl === config.baseUrl &&
    lane.apiKey === config.apiKey;
}

/** 取该配置所属 lane 的执行器；没有时建立新 lane。 */
export function quotaRunnerFor(config: QuotaLaneIdentity): PrioritizedBoundedTaskRunner {
  for (const lane of aiProviderQuotaLanes) {
    if (isQuotaLaneOf(lane, config)) return lane.runner;
  }
  const lane: AiProviderQuotaLane = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: AI_PROVIDER_MAX_CONCURRENT,
      maxPending: AI_PROVIDER_MAX_PENDING,
      maxBackgroundPending: AI_PROVIDER_BACKGROUND_MAX_PENDING,
      interactiveBurst: AI_PROVIDER_INTERACTIVE_BURST,
    }),
  };
  aiProviderQuotaLanes.push(lane);
  return lane.runner;
}

/** lane 仍被新快照的某项能力引用时保留。 */
function isQuotaLaneInUse(lane: AiProviderQuotaLane, config: AgentDeploymentConfig): boolean {
  return isQuotaLaneOf(lane, config.text) ||
    isQuotaLaneOf(lane, config.summary) ||
    isQuotaLaneOf(lane, config.media) ||
    (config.image !== undefined && isQuotaLaneOf(lane, config.image)) ||
    (config.tts !== undefined && isQuotaLaneOf(lane, config.tts)) ||
    (config.webSearch !== undefined && isQuotaLaneOf(lane, config.webSearch));
}

/**
 * 按新的 agent 配置快照就地摘除不再被任何能力引用的 lane；仍被引用的 lane 原样保留，
 * 在途与排队任务及并发额度跨重载延续。
 */
export function pruneQuotaLanes(config: AgentDeploymentConfig): void {
  let kept: number = 0;
  for (const lane of aiProviderQuotaLanes) {
    if (isQuotaLaneInUse(lane, config)) aiProviderQuotaLanes[kept++] = lane;
  }
  aiProviderQuotaLanes.length = kept;
}
