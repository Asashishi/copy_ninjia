/**
 * 主线程借用 AI Worker 的摘要生成（aiChat/ai/webDigest.ts）：cron `send_web_digest` 经这里把主题与
 * 组稿参数交给 Worker，拿回可直接按 MarkdownV2 发送的原文，再由 cron/delivery.ts 发出。
 *
 * 一次请求经 aiChat/workerJob.ts 在 cache/main/aiChat.ts 的 webDigestRequests 登记一个等待者再投递
 * composeWebDigest，等待上限为 WEB_DIGEST_REQUEST_TIMEOUT_MS；超时与取消会再投一条 cancelWebDigest 让
 * Worker 中止在途组稿。结算一律交回 WebDigestCompositionResult，不抛错。投递函数由
 * aiChat/workerBridge.ts 注入，本模块不反向导入 bridge；webDigestComposed 回执与 Worker 失效时的
 * 整表失败结算也在 bridge 里直接对等待表执行。
 */

import { agentDeploymentConfigSnapshot } from "../config/agent";
import { WEB_DIGEST_REQUEST_TIMEOUT_MS } from "../consts/webDigest";
import { webDigestRequests } from "../cache/main/aiChat";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { AiWorkerJobTransport } from "../types/aiChat/workerJob";
import type { WebDigestCompositionResult, WebDigestRequest } from "../types/webDigest";
import { requestAiWorkerJob } from "./workerJob";

/**
 * 请 AI Worker 生成一份摘要。没有对话核心能力配置时直接返回「ai unconfigured」，Worker
 * 不可用时返回「worker unavailable」，都不投递。
 * @param signal 调用方取消信号；中止时立即按 aborted 结算并撤回 Worker 侧组稿。
 */
export function requestWebDigest(
  request: WebDigestRequest,
  signal: AbortSignal,
  transport: AiWorkerJobTransport
): Promise<WebDigestCompositionResult> {
  if (agentDeploymentConfigSnapshot() === null) return Promise.resolve({ ok: false, reason: "ai unconfigured" });
  return requestAiWorkerJob<WebDigestCompositionResult>({
    table: webDigestRequests,
    timeoutMs: WEB_DIGEST_REQUEST_TIMEOUT_MS,
    transport,
    signal,
    start: (requestId: number): AiChatWorkerMessage => ({ type: "composeWebDigest", requestId, request }),
    cancel: (requestId: number): AiChatWorkerMessage => ({ type: "cancelWebDigest", requestId }),
  });
}
