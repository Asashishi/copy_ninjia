/**
 * 主线程转交语音合成的等待者：回执、等待超时、调用方取消、投递被拒与整体失败各自
 * 只结算一次，超时与取消会撤回 Worker 侧合成；能力缺席与 Worker 不可用时不投递。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig } from "../../packages/config/agent";
import { voiceSynthesisWaiters } from "../../packages/cache/main/aiChat";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../../packages/consts/aiChat/voiceMessage";
import {
  failAllVoiceSynthesisWaiters,
  requestVoiceSynthesis,
  settleVoiceSynthesis,
} from "../../packages/aiChat/voiceSynthesis";
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
  failAllVoiceSynthesisWaiters();
  jest.useRealTimers();
});

describe("requestVoiceSynthesis", () => {
  test("agent.tts 缺省或 Worker 不可用时不投递", async () => {
    adoptAgentDeploymentConfig({ ...AGENT, tts: undefined });
    await expect(request()).resolves.toEqual({ ok: false, reason: "tts unconfigured" });
    adoptAgentDeploymentConfig(AGENT);
    await expect(requestVoiceSynthesis({ text: "hi", tone: undefined, signal: undefined }, { post, workerAvailable: false }))
      .resolves.toEqual({ ok: false, reason: "worker unavailable" });
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await expect(request(aborted.signal)).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(posts).toEqual([]);
  });

  test("回执按 requestId 结算并摘掉等待者与取消监听", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<VoiceSynthesisResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    expect(posts).toEqual([{ type: "synthesizeVoice", requestId, text: "おやすみ", tone: "眠そうに" }]);
    settleVoiceSynthesis({ type: "voiceSynthesized", requestId, result: { ok: false, reason: "synthesis failed" } });
    await expect(pending).resolves.toEqual({ ok: false, reason: "synthesis failed" });
    expect(voiceSynthesisWaiters.size).toBe(0);
    controller.abort();
    expect(posts).toHaveLength(1);
  });

  test("调用方取消时立即结算并撤回 Worker 侧合成，迟到回执被丢弃", async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<VoiceSynthesisResult> = request(controller.signal);
    const requestId: number = lastRequestId();
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(posts.at(-1)).toEqual({ type: "cancelVoiceSynthesis", requestId });
    settleVoiceSynthesis({ type: "voiceSynthesized", requestId, result: { ok: false, reason: "aborted" } });
    expect(voiceSynthesisWaiters.size).toBe(0);
  });

  test("等待超时按 timed out 结算并撤回合成", async () => {
    jest.useFakeTimers();
    const pending: Promise<VoiceSynthesisResult> = request();
    const requestId: number = lastRequestId();
    jest.advanceTimersByTime(VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, reason: "timed out" });
    expect(posts.at(-1)).toEqual({ type: "cancelVoiceSynthesis", requestId });
  });

  test("投递被拒与 Worker 整体失效都按 worker unavailable 结算", async () => {
    accepting = false;
    await expect(request()).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    accepting = true;
    const first: Promise<VoiceSynthesisResult> = request();
    const second: Promise<VoiceSynthesisResult> = request();
    expect(voiceSynthesisWaiters.size).toBe(2);
    failAllVoiceSynthesisWaiters();
    await expect(first).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    await expect(second).resolves.toEqual({ ok: false, reason: "worker unavailable" });
    expect(voiceSynthesisWaiters.size).toBe(0);
  });
});
