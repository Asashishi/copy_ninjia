/**
 * cron `send_web_digest` 转交的摘要组稿在 AI Worker 侧的执行：经 aiChat/ai/webDigest.ts 检索并组稿，
 * 以同 requestId 的 webDigestComposed 回执带回结果。
 *
 * 每次请求的取消信号合入 Worker 的统一生命周期信号：Worker 停止或进入排空时在途组稿一并中止；
 * 排空开始后到达的请求直接回「worker unavailable」。在途表见 cache/workers/aiChat/webDigest.ts。
 */

import { aiChatWorkerAbortController, aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
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

declare const self: Worker;

/** 组稿一次；排空期间与对话能力缺席时直接返回失败原因，意外异常按组稿失败结算。 */
async function compose(
  msg: AiComposeWebDigestMessage,
  controller: AbortController
): Promise<WebDigestCompositionResult> {
  if (aiChatWorkerQuiescing.current) return { ok: false, reason: "worker unavailable" };
  if (agentDeploymentConfigSnapshot() === null) return { ok: false, reason: "ai unconfigured" };
  try {
    return await composeWebDigest(
      msg.request,
      AbortSignal.any([controller.signal, aiChatWorkerAbortController.current.signal])
    );
  } catch (error: unknown) {
    logger.error(`Web digest composition for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "compose failed" };
  }
}

/** 接纳一次组稿请求；结算后回执并摘除在途条目。 */
export function handleComposeWebDigest(msg: AiComposeWebDigestMessage): void {
  const controller: AbortController = new AbortController();
  webDigestRequests.set(msg.requestId, controller);
  void compose(msg, controller).then((result: WebDigestCompositionResult): void => {
    if (webDigestRequests.get(msg.requestId) === controller) webDigestRequests.delete(msg.requestId);
    const event: AiWebDigestComposedEvent = { type: "webDigestComposed", requestId: msg.requestId, result };
    self.postMessage(event);
  });
}

/** 撤回一次在途组稿；已结算或未知的 requestId 不做任何事。 */
export function handleCancelWebDigest(msg: AiCancelWebDigestMessage): void {
  webDigestRequests.get(msg.requestId)?.abort();
}
