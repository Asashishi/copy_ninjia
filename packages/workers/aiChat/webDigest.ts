/**
 * cron `send_web_digest` 转交的摘要组稿在 AI Worker 侧的执行：经 aiChat/ai/webDigest.ts 检索并组稿，
 * 以同 requestId 的 webDigestComposed 回执带回结果。
 *
 * 登记、生命周期信号与排空期间的拒收见 ./workerJob.ts；在途表见 cache/workers/aiChat/webDigest.ts。
 */

import { webDigestRequests } from "../../cache/workers/aiChat/webDigest";
import { composeWebDigest } from "../../aiChat/ai/webDigest";
import { agentDeploymentConfigSnapshot } from "../../config/agent";
import { logger } from "../../infra/logger";
import type {
  AiCancelWebDigestMessage,
  AiComposeWebDigestMessage,
  AiWebDigestComposedEvent,
} from "../../types/aiChat/protocol";
import type { WebDigestCompositionResult } from "../../types/webDigest";
import { runAiWorkerJob } from "./workerJob";

declare const self: Worker;

/** 组稿一次；对话能力缺席时直接返回失败原因，意外异常按组稿失败结算。 */
async function compose(msg: AiComposeWebDigestMessage, signal: AbortSignal): Promise<WebDigestCompositionResult> {
  if (agentDeploymentConfigSnapshot() === null) return { ok: false, reason: "ai unconfigured" };
  try {
    return await composeWebDigest(msg.request, signal);
  } catch (error: unknown) {
    logger.error(`Web digest composition for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "compose failed" };
  }
}

/** 接纳一次组稿请求；结算后回执。 */
export function handleComposeWebDigest(msg: AiComposeWebDigestMessage): void {
  runAiWorkerJob<WebDigestCompositionResult>({
    jobs: webDigestRequests,
    requestId: msg.requestId,
    run: (signal: AbortSignal): Promise<WebDigestCompositionResult> => compose(msg, signal),
    publish: (result: WebDigestCompositionResult): void => {
      self.postMessage({ type: "webDigestComposed", requestId: msg.requestId, result } satisfies AiWebDigestComposedEvent);
    },
  });
}

/** 撤回一次在途组稿；已结算或未知的 requestId 不做任何事。 */
export function handleCancelWebDigest(msg: AiCancelWebDigestMessage): void {
  webDigestRequests.get(msg.requestId)?.abort();
}
