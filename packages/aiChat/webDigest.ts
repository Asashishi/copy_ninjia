/**
 * 主线程借用 AI Worker 的摘要生成（aiChat/ai/webDigest.ts）：cron `send_web_digest` 经这里把主题与
 * 组稿参数交给 Worker，拿回可直接按 MarkdownV2 发送的原文，再由 cron/delivery.ts 发出。
 *
 * 一次请求登记一个等待者（cache/main/aiChat.ts 的 webDigestWaiters）再投递 composeWebDigest；结算
 * 只有五条路：回执、等待超时（WEB_DIGEST_REQUEST_TIMEOUT_MS）、调用方取消、投递被拒、Worker 崩溃
 * 重建 / 放弃 / 终止。超时与取消会再投一条 cancelWebDigest 让 Worker 中止在途组稿。结算一律交回
 * WebDigestCompositionResult，不抛错。投递函数由 aiChat/workerBridge.ts 注入，本模块不反向导入 bridge。
 */

import { agentDeploymentConfigSnapshot } from "../config/agent";
import { WEB_DIGEST_REQUEST_TIMEOUT_MS } from "../consts/webDigest";
import { webDigestRequestCounter, webDigestWaiters } from "../cache/main/aiChat";
import type { AiChatWorkerMessage, AiWebDigestComposedEvent } from "../types/aiChat/protocol";
import type { WebDigestWaiter } from "../types/aiChat/waiters";
import type { WebDigestCompositionResult, WebDigestRequest } from "../types/webDigest";

/** requestWebDigest 的注入项：投递函数与 Worker 此刻是否可用。 */
export interface WebDigestTransport {
  /** 向当前 AI Worker 投递；返回 false 表示同步拒绝。 */
  readonly post: (message: AiChatWorkerMessage) => boolean;
  readonly workerAvailable: boolean;
}

/** 摘除并收尾一个等待者；返回它以便调用方结算，已结算时返回 undefined。 */
function takeWaiter(requestId: number): WebDigestWaiter | undefined {
  const waiter: WebDigestWaiter | undefined = webDigestWaiters.get(requestId);
  if (waiter === undefined) return undefined;
  webDigestWaiters.delete(requestId);
  clearTimeout(waiter.timer);
  waiter.signal.removeEventListener("abort", waiter.onAbort);
  return waiter;
}

/** 超时或取消：结算等待者并通知 Worker 撤回这次组稿。 */
function withdraw(
  requestId: number,
  post: (message: AiChatWorkerMessage) => boolean,
  reason: "timed out" | "aborted"
): void {
  const waiter: WebDigestWaiter | undefined = takeWaiter(requestId);
  if (waiter === undefined) return;
  post({ type: "cancelWebDigest", requestId });
  waiter.resolve({ ok: false, reason });
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
  return new Promise((resolve: (result: WebDigestCompositionResult) => void): void => {
    const requestId: number = ++webDigestRequestCounter.current;
    const waiter: WebDigestWaiter = {
      resolve,
      timer: setTimeout((): void => withdraw(requestId, post, "timed out"), WEB_DIGEST_REQUEST_TIMEOUT_MS),
      signal,
      onAbort: (): void => withdraw(requestId, post, "aborted"),
    };
    // 等待者在投递之前登记，同步回执也不会丢（同 libs/flushBarrier.ts 的顺序约定）。
    webDigestWaiters.set(requestId, waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (!post({ type: "composeWebDigest", requestId, request })) {
      takeWaiter(requestId)?.resolve({ ok: false, reason: "worker unavailable" });
    }
  });
}

/** webDigestComposed 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。 */
export function settleWebDigest(event: AiWebDigestComposedEvent): void {
  takeWaiter(event.requestId)?.resolve(event.result);
}

/** Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按不可用结算。 */
export function failAllWebDigestWaiters(): void {
  for (const requestId of [...webDigestWaiters.keys()]) {
    takeWaiter(requestId)?.resolve({ ok: false, reason: "worker unavailable" });
  }
}
