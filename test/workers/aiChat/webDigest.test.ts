import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AgentDeploymentConfig } from "../../../packages/types/config";
import type { AiWebDigestComposedEvent } from "../../../packages/types/aiChat/protocol";
import type { WebDigestCompositionResult, WebDigestRequest } from "../../../packages/types/webDigest";

/**
 * AI Worker 侧的摘要组稿边界（workers/aiChat/webDigest.ts）：排空与未配置时的直接失败、组稿异常的
 * 结算、主线程撤回与 Worker 生命周期中止、在途表摘除，以及重复 requestId 下只摘除自己的条目。
 */

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const posted: AiWebDigestComposedEvent[] = [];
const postWaiters: (() => void)[] = [];
const postMessage = mock((event: AiWebDigestComposedEvent): void => {
  posted.push(event);
  postWaiters.shift()?.();
});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

type ComposeWebDigest = (request: WebDigestRequest, signal: AbortSignal) => Promise<WebDigestCompositionResult>;
const composeWebDigest = mock<ComposeWebDigest>((): Promise<WebDigestCompositionResult> =>
  Promise.resolve({ ok: true, text: "digest" }));
mock.module("../../../packages/aiChat/ai/webDigest", () => ({ composeWebDigest }));
const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { handleCancelWebDigest, handleComposeWebDigest } = await import("../../../packages/workers/aiChat/webDigest");
const { webDigestRequests } = await import("../../../packages/cache/workers/aiChat/webDigest");
const { aiChatWorkerAbortController, aiChatWorkerQuiescing } = await import("../../../packages/cache/workers/aiChat/worker");
const { adoptAgentDeploymentConfig, agentDeploymentConfigSnapshot } = await import("../../../packages/config/agent");

const REQUEST: WebDigestRequest = { topic: "今日要闻", language: "zh", maxItems: 3, instructions: undefined };
const configured: AgentDeploymentConfig | null = agentDeploymentConfigSnapshot();

/** 等到下一次 webDigestComposed 回执投递。 */
function nextPost(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => { postWaiters.push(resolve); });
}

/** 让 composeWebDigest 挂起，直到信号中止才以 aborted 结算；返回收到的信号。 */
function holdUntilAborted(): Promise<AbortSignal> {
  return new Promise<AbortSignal>((resolveSignal: (signal: AbortSignal) => void): void => {
    composeWebDigest.mockImplementationOnce((_request: WebDigestRequest, signal: AbortSignal): Promise<WebDigestCompositionResult> => {
      resolveSignal(signal);
      return new Promise<WebDigestCompositionResult>((resolve: (result: WebDigestCompositionResult) => void): void => {
        signal.addEventListener("abort", (): void => { resolve({ ok: false, reason: "aborted" }); }, { once: true });
      });
    });
  });
}

beforeEach((): void => {
  posted.length = 0;
  postWaiters.length = 0;
  postMessage.mockClear();
  composeWebDigest.mockClear();
  loggerError.mockClear();
  webDigestRequests.clear();
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  adoptAgentDeploymentConfig(configured);
});

afterEach((): void => {
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  adoptAgentDeploymentConfig(configured);
});

afterAll((): void => {
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("AI Worker 摘要组稿", () => {
  test("组稿成功时原样回执结果并摘除在途条目", async () => {
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 1, request: REQUEST });
    expect(webDigestRequests.has(1)).toBeTrue();
    await settled;
    expect(composeWebDigest).toHaveBeenCalledTimes(1);
    expect(composeWebDigest.mock.calls[0]?.[0]).toBe(REQUEST);
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 1, result: { ok: true, text: "digest" } }]);
    expect(webDigestRequests.size).toBe(0);
  });

  test("排空开始后到达的请求直接回 worker unavailable，不进入组稿", async () => {
    aiChatWorkerQuiescing.current = true;
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 2, request: REQUEST });
    await settled;
    expect(composeWebDigest).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 2, result: { ok: false, reason: "worker unavailable" } }]);
    expect(webDigestRequests.size).toBe(0);
  });

  test("没有对话能力配置时回 ai unconfigured，不进入组稿", async () => {
    adoptAgentDeploymentConfig(null);
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 3, request: REQUEST });
    await settled;
    expect(composeWebDigest).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 3, result: { ok: false, reason: "ai unconfigured" } }]);
  });

  test("组稿抛错时按 compose failed 结算并记录错误日志", async () => {
    composeWebDigest.mockImplementationOnce((): Promise<WebDigestCompositionResult> => Promise.reject(new Error("boom")));
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 4, request: REQUEST });
    await settled;
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 4, result: { ok: false, reason: "compose failed" } }]);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(String(loggerError.mock.calls[0]?.[0])).toContain("request 4");
    expect(webDigestRequests.size).toBe(0);
  });

  test("主线程撤回中止在途组稿；未知或已结算的 requestId 不受影响", async () => {
    const signal: Promise<AbortSignal> = holdUntilAborted();
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 5, request: REQUEST });
    const received: AbortSignal = await signal;
    handleCancelWebDigest({ type: "cancelWebDigest", requestId: 99 });
    expect(received.aborted).toBeFalse();
    handleCancelWebDigest({ type: "cancelWebDigest", requestId: 5 });
    expect(received.aborted).toBeTrue();
    await settled;
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 5, result: { ok: false, reason: "aborted" } }]);
    expect(webDigestRequests.size).toBe(0);
    handleCancelWebDigest({ type: "cancelWebDigest", requestId: 5 });
    expect(posted).toHaveLength(1);
  });

  test("Worker 生命周期信号中止时在途组稿一并中止", async () => {
    const signal: Promise<AbortSignal> = holdUntilAborted();
    const settled: Promise<void> = nextPost();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 6, request: REQUEST });
    const received: AbortSignal = await signal;
    aiChatWorkerAbortController.current.abort();
    expect(received.aborted).toBeTrue();
    await settled;
    expect(posted).toEqual([{ type: "webDigestComposed", requestId: 6, result: { ok: false, reason: "aborted" } }]);
  });

  test("重复 requestId 时先结算的一方不摘除后登记的条目，撤回只作用于后者", async () => {
    let resolveFirst: (result: WebDigestCompositionResult) => void = (): void => {};
    composeWebDigest.mockImplementationOnce((): Promise<WebDigestCompositionResult> =>
      new Promise<WebDigestCompositionResult>((resolve: (result: WebDigestCompositionResult) => void): void => { resolveFirst = resolve; }));
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 8, request: REQUEST });
    const second: Promise<AbortSignal> = holdUntilAborted();
    handleComposeWebDigest({ type: "composeWebDigest", requestId: 8, request: REQUEST });
    const secondSignal: AbortSignal = await second;

    const firstSettled: Promise<void> = nextPost();
    resolveFirst({ ok: true, text: "first" });
    await firstSettled;
    expect(webDigestRequests.has(8)).toBeTrue();
    const secondSettled: Promise<void> = nextPost();
    handleCancelWebDigest({ type: "cancelWebDigest", requestId: 8 });
    expect(secondSignal.aborted).toBeTrue();
    await secondSettled;
    expect(posted.map((event: AiWebDigestComposedEvent): WebDigestCompositionResult => event.result))
      .toEqual([{ ok: true, text: "first" }, { ok: false, reason: "aborted" }]);
    expect(webDigestRequests.size).toBe(0);
  });
});
