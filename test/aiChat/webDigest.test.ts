/**
 * 主线程转交摘要组稿的等待者：回执、等待超时、调用方取消、投递被拒与整体失败各自只结算一次，
 * 超时与取消会撤回 Worker 侧组稿；没有对话能力与 Worker 不可用时不投递。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig } from "../../packages/config/agent";
import { webDigestRequests } from "../../packages/cache/main/aiChat";
import { WEB_DIGEST_REQUEST_TIMEOUT_MS } from "../../packages/consts/webDigest";
import { failAllWebDigestWaiters, requestWebDigest, settleWebDigest } from "../../packages/aiChat/webDigest";
import type { AiChatWorkerMessage } from "../../packages/types/aiChat/protocol";
import type { AgentDeploymentConfig } from "../../packages/types/config";
import type { WebDigestCompositionResult, WebDigestRequest } from "../../packages/types/webDigest";

const AGENT: AgentDeploymentConfig = getAgentDeploymentConfig();
const REQUEST: WebDigestRequest = { topic: "今日新闻", language: "zh", maxItems: 5, instructions: undefined };
const posts: AiChatWorkerMessage[] = [];
let accepting: boolean = true;
function post(message: AiChatWorkerMessage): boolean {
  posts.push(message);
  return accepting;
}

function request(signal: AbortSignal = new AbortController().signal): Promise<WebDigestCompositionResult> {
  return requestWebDigest(REQUEST, signal, { post, workerAvailable: true });
}

function lastRequestId(): number {
  const message: AiChatWorkerMessage | undefined = posts.at(-1);
  if (message?.type !== "composeWebDigest") throw new Error("Expected a composeWebDigest request");
  return message.requestId;
}

beforeEach(() => {
  posts.length = 0;
  accepting = true;
  adoptAgentDeploymentConfig(AGENT);
});

afterEach(() => {
  failAllWebDigestWaiters();
  adoptAgentDeploymentConfig(AGENT);
  jest.useRealTimers();
});

describe("requestWebDigest", () => {
  test("没有对话能力、Worker 不可用或已取消时不投递", async () => {
    adoptAgentDeploymentConfig(null);
    await expect(request()).resolves.toEqual({ ok: false, reason: "ai unconfigured" });
    adoptAgentDeploymentConfig(AGENT);
    await expect(requestWebDigest(REQUEST, new AbortController().signal, { post, workerAvailable: false }))
      .resolves.toEqual({ ok: false, reason: "worker unavailable" });
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await expect(request(aborted.signal)).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(posts).toEqual([]);
  });

  test("回执按 requestId 结算并摘掉等待者与取消监听", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<WebDigestCompositionResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    expect(posts).toEqual([{ type: "composeWebDigest", requestId, request: REQUEST }]);
    settleWebDigest({ type: "webDigestComposed", requestId, result: { ok: true, text: "*摘要*" } });
    await expect(pending).resolves.toEqual({ ok: true, text: "*摘要*" });
    expect(webDigestRequests.waiters.size).toBe(0);
    controller.abort();
    expect(posts).toHaveLength(1);
  });

  test("调用方取消时立即结算并撤回 Worker 侧组稿，迟到回执被丢弃", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<WebDigestCompositionResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(posts.at(-1)).toEqual({ type: "cancelWebDigest", requestId });
    settleWebDigest({ type: "webDigestComposed", requestId, result: { ok: false, reason: "aborted" } });
    expect(webDigestRequests.waiters.size).toBe(0);
  });

  test("等待超时按 timed out 结算并撤回组稿", async () => {
    jest.useFakeTimers();
    const pending: Promise<WebDigestCompositionResult> = request();
    const requestId: number = lastRequestId();
    jest.advanceTimersByTime(WEB_DIGEST_REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timed out" });
    expect(posts.at(-1)).toEqual({ type: "cancelWebDigest", requestId });
  });

  test("投递被拒与 Worker 整体失效都按 worker unavailable 结算", async () => {
    accepting = false;
    await expect(request()).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    accepting = true;
    const first: Promise<WebDigestCompositionResult> = request();
    const second: Promise<WebDigestCompositionResult> = request();
    expect(webDigestRequests.waiters.size).toBe(2);
    failAllWebDigestWaiters();
    await expect(first).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    await expect(second).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    expect(webDigestRequests.waiters.size).toBe(0);
  });
});
