/**
 * 主线程借用 AI Worker 的摘要生成（aiChat/ai/webDigest.ts）：cron `send_web_digest` 经这里把主题与
 * 组稿参数交给 Worker，拿回可直接按 MarkdownV2 发送的原文，再由 cron/delivery.ts 发出。
 *
 * 一次请求在 cache/main/aiChat.ts 的 webDigestRequests 登记一个等待者再投递 composeWebDigest；等待与
 * 结算见 libs/workerRequestTable.ts，等待上限为 WEB_DIGEST_REQUEST_TIMEOUT_MS。超时与取消会再投一条
 * cancelWebDigest 让 Worker 中止在途组稿。结算一律交回 WebDigestCompositionResult，不抛错。投递函数由
 * aiChat/workerBridge.ts 注入，本模块不反向导入 bridge。
 */

import { agentDeploymentConfigSnapshot } from "../config/agent";
import { WEB_DIGEST_REQUEST_TIMEOUT_MS } from "../consts/webDigest";
import { webDigestRequests } from "../cache/main/aiChat";
import { beginWorkerRequest, failAllWorkerRequests, settleWorkerRequest } from "../libs/workerRequestTable";
import type { AiChatWorkerMessage, AiWebDigestComposedEvent } from "../types/aiChat/protocol";
import type { WebDigestCompositionResult, WebDigestRequest } from "../types/webDigest";

/** requestWebDigest 的注入项：投递函数与 Worker 此刻是否可用。 */
export interface WebDigestTransport {
  /** 向当前 AI Worker 投递；返回 false 表示同步拒绝。 */
  readonly post: (message: AiChatWorkerMessage) => boolean;
  readonly workerAvailable: boolean;
}

/**
 * 请 AI Worker 生成一份摘要。没有对话核心能力配置时直接返回「ai unconfigured」，Worker
 * 不可用时返回「worker unavailable」，都不投递。
 * @param signal 调用方取消信号；中止时立即按 aborted 结算并撤回 Worker 侧组稿。
 */
export function requestWebDigest(
  request: WebDigestRequest,
  signal: AbortSignal,
  { post, workerAvailable }: WebDigestTransport
): Promise<WebDigestCompositionResult> {
  if (agentDeploymentConfigSnapshot() === null) return Promise.resolve({ ok: false, reason: "ai unconfigured" });
  if (!workerAvailable) return Promise.resolve({ ok: false, reason: "worker unavailable" });
  if (signal.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
  return beginWorkerRequest<WebDigestCompositionResult>({
    table: webDigestRequests,
    timeoutMs: WEB_DIGEST_REQUEST_TIMEOUT_MS,
    post: (requestId: number): boolean => post({ type: "composeWebDigest", requestId, request }),
    cancel: (requestId: number): void => {
      post({ type: "cancelWebDigest", requestId });
    },
    abort: { signal, result: { ok: false, reason: "aborted" } },
    timedOut: { ok: false, reason: "timed out" },
    rejected: { ok: false, reason: "worker unavailable" },
  });
}

/** webDigestComposed 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。 */
export function settleWebDigest(event: AiWebDigestComposedEvent): void {
  settleWorkerRequest(webDigestRequests, event.requestId, event.result);
}

/** Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按不可用结算。 */
export function failAllWebDigestWaiters(): void {
  failAllWorkerRequests<WebDigestCompositionResult>(webDigestRequests, { ok: false, reason: "worker unavailable" });
}
