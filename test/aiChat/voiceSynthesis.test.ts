/**
 * 主线程转交语音合成的等待者：回执、等待超时、调用方取消、投递被拒与整体失败各自
 * 只结算一次，超时与取消会撤回 Worker 侧合成；能力缺席与 Worker 不可用时不投递。
 */

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { logger } from "../../packages/infra/logger";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig } from "../../packages/config/agent";
import { voiceSynthesisRequests } from "../../packages/cache/main/aiChat";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../../packages/consts/aiChat/voiceMessage";
import { requestVoiceSynthesis } from "../../packages/aiChat/voiceSynthesis";
import { AI_WORKER_JOB_ABORTED, AI_WORKER_JOB_TIMED_OUT, AI_WORKER_JOB_UNAVAILABLE } from "../../packages/consts/aiChat/workerJob";
import { failAllWorkerRequests, settleWorkerRequest } from "../../packages/libs/workerRequestTable";
import type { VoiceSynthesisRequest } from "../../packages/aiChat/voiceSynthesis";
import type { AiChatWorkerMessage } from "../../packages/types/aiChat/protocol";
import type { AgentDeploymentConfig } from "../../packages/types/config";
import type { VoiceSynthesisResult } from "../../packages/types/aiChat/voiceMessage";

const AGENT: AgentDeploymentConfig = getAgentDeploymentConfig();
const posts: AiChatWorkerMessage[] = [];
let accepting: boolean = true;
function post(message: AiChatWorkerMessage): boolean {
  posts.push(message);
  return accepting;
}

function request(signal?: AbortSignal): Promise<VoiceSynthesisResult> {
  const input: VoiceSynthesisRequest = { text: "おやすみ", tone: "眠そうに", signal };
  return requestVoiceSynthesis(input, { post, workerAvailable: true });
}

function lastRequestId(): number {
  const message: AiChatWorkerMessage | undefined = posts.at(-1);
  if (message?.type !== "synthesizeVoice") throw new Error("Expected a synthesizeVoice request");
  return message.requestId;
}

beforeEach(() => {
  posts.length = 0;
  accepting = true;
  adoptAgentDeploymentConfig(AGENT);
});

afterEach(() => {
  failAllWorkerRequests<VoiceSynthesisResult>(voiceSynthesisRequests, AI_WORKER_JOB_UNAVAILABLE);
  jest.useRealTimers();
});

describe("requestVoiceSynthesis", () => {
  test("agent.tts 缺省或 Worker 不可用时不投递", async () => {
    adoptAgentDeploymentConfig({ ...AGENT, tts: undefined });
    await expect(request()).resolves.toEqual({ ok: false, reason: "tts unconfigured" });
    adoptAgentDeploymentConfig(AGENT);
    await expect(requestVoiceSynthesis({ text: "hi", tone: undefined, signal: undefined }, { post, workerAvailable: false }))
      .resolves.toEqual(AI_WORKER_JOB_UNAVAILABLE);
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await expect(request(aborted.signal)).resolves.toEqual(AI_WORKER_JOB_ABORTED);
    expect(posts).toEqual([]);
  });

  test("投递同步抛错时记一行诊断，按 worker unavailable 结算且不留等待者", async () => {
    const errorLog = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      const thrown: Error = new Error("structured clone failed");
      await expect(requestVoiceSynthesis({ text: "hi", tone: undefined, signal: undefined }, {
        post: (): boolean => {
          throw thrown;
        },
        workerAvailable: true,
      })).resolves.toEqual(AI_WORKER_JOB_UNAVAILABLE);
      expect(errorLog).toHaveBeenCalledWith("Failed to post an AI Worker job request:", thrown);
      expect(voiceSynthesisRequests.waiters.size).toBe(0);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("回执按 requestId 结算并摘掉等待者与取消监听", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<VoiceSynthesisResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    expect(posts).toEqual([{ type: "synthesizeVoice", requestId, text: "おやすみ", tone: "眠そうに" }]);
    settleWorkerRequest(voiceSynthesisRequests, requestId, { ok: false, reason: "synthesis failed" });
    await expect(pending).resolves.toEqual({ ok: false, reason: "synthesis failed" });
    expect(voiceSynthesisRequests.waiters.size).toBe(0);
    controller.abort();
    expect(posts).toHaveLength(1);
  });

  test("调用方取消时立即结算并撤回 Worker 侧合成，迟到回执被丢弃", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<VoiceSynthesisResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    controller.abort();
    await expect(pending).resolves.toEqual(AI_WORKER_JOB_ABORTED);
    expect(posts.at(-1)).toEqual({ type: "cancelVoiceSynthesis", requestId });
    settleWorkerRequest(voiceSynthesisRequests, requestId, { ok: false, reason: "aborted" });
    expect(voiceSynthesisRequests.waiters.size).toBe(0);
  });

  test("等待超时按 timed out 结算并撤回合成", async () => {
    jest.useFakeTimers();
    const pending: Promise<VoiceSynthesisResult> = request();
    const requestId: number = lastRequestId();
    jest.advanceTimersByTime(VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual(AI_WORKER_JOB_TIMED_OUT);
    expect(posts.at(-1)).toEqual({ type: "cancelVoiceSynthesis", requestId });
  });

  test("投递被拒与 Worker 整体失效都按 worker unavailable 结算", async () => {
    accepting = false;
    await expect(request()).resolves.toEqual(AI_WORKER_JOB_UNAVAILABLE);
    accepting = true;
    const first: Promise<VoiceSynthesisResult> = request();
    const second: Promise<VoiceSynthesisResult> = request();
    expect(voiceSynthesisRequests.waiters.size).toBe(2);
    failAllWorkerRequests<VoiceSynthesisResult>(voiceSynthesisRequests, AI_WORKER_JOB_UNAVAILABLE);
    await expect(first).resolves.toEqual(AI_WORKER_JOB_UNAVAILABLE);
    await expect(second).resolves.toEqual(AI_WORKER_JOB_UNAVAILABLE);
    expect(voiceSynthesisRequests.waiters.size).toBe(0);
  });
});
