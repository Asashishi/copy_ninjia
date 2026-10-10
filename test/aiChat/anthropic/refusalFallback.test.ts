/**
 * 拒答回退的真实 SDK 链路：本机 Bun.serve 充当 Messages 端点。校验请求走 beta 端点；配置了 fallback_model
 * 时 betaRefusalFallbackMiddleware 在每个请求上带 fallback-credit beta，以回退模型重发同一请求体并按 best_effort
 * 兑换拒答带回的额度令牌（拒答不带令牌时不兑换），用量记回退模型的配置写法并记带兑换结果的改道日志；回复会话改道后后续请求
 * 直接发给回退模型、历史里不带 fallback 块，新会话重新从 model 起发；回退模型也拒答或未配置回退时都只按 refused 交回，不再
 * 重发；回退模型也拒答、回退请求失败时各记一条改道 warn；日志里的 stop_details 不含回退额度令牌。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AiReplySession, AiReplyTurn, AiReplyTurnRequest, AiTextResult } from "../../../packages/types/aiChat/provider";
import type { AgentDeploymentConfig, AnthropicAgentCapabilityConfig } from "../../../packages/types/config";
import type Anthropic from "@anthropic-ai/sdk";

const loggerWarn = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ warn: loggerWarn, error: loggerError }) }));

const { requestAnthropicTextResult } = await import("../../../packages/aiChat/anthropic/client");
const { createAnthropicReplySession } = await import("../../../packages/aiChat/anthropic/replySession");
const { anthropicClientCache } = await import("../../../packages/cache/workers/aiChat/anthropic");
const { adoptAgentDeploymentConfig, getAgentDeploymentConfig } = await import("../../../packages/config/agent");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");

/**
 * 端点按队列给出的一次响应形态；`refusal-no-credit` 是不带回退额度令牌的拒答，`bad-request` 是 SDK 不重试的 400。
 */
type ReplyKind = "text" | "tool" | "refusal" | "refusal-no-credit" | "bad-request";

interface CapturedRequest {
  readonly path: string;
  readonly beta: string | null;
  readonly body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
}

const PRIMARY: string = "claude-primary";
const FALLBACK: string = "claude-fallback";
const CREDIT_BETA: string = "fallback-credit-2026-07-01";
const CREDIT_TOKEN: string = "credit-token";
const REFUSAL_DETAILS = { type: "refusal", category: "cyber", explanation: null } as const;
const captured: CapturedRequest[] = [];
const replies: ReplyKind[] = [];
const reported: AiCacheUsage[] = [];
/** 端点回显的 model 在请求名之后追加的后缀；非空时模拟别名被回显成带日期的规范 ID。 */
let echoedModelSuffix: string = "";

/** 端点收到的一次请求在响应构造里用到的部分。 */
interface ReceivedRequest {
  readonly model: string;
  /** 请求带了 fallback-credit beta。 */
  readonly creditBeta: boolean;
  /** 请求带了回退额度令牌。 */
  readonly redeeming: boolean;
}

function messageJson(kind: ReplyKind, { model, creditBeta, redeeming }: ReceivedRequest): unknown {
  const refused: boolean = kind === "refusal" || kind === "refusal-no-credit";
  const creditToken: string | null = kind === "refusal" ? CREDIT_TOKEN : null;
  return {
    id: `msg_${captured.length}`,
    type: "message",
    role: "assistant",
    model: `${model}${echoedModelSuffix}`,
    content: refused
      ? []
      : kind === "tool"
        ? [{ type: "tool_use", id: "tu_1", name: "send_message", input: { text: "嗨" } }]
        : [{ type: "text", text: `${model} 正文`, citations: null }],
    stop_reason: refused ? "refusal" : kind === "tool" ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: !refused
      ? null
      : creditBeta
        ? { ...REFUSAL_DETAILS, fallback_credit_token: creditToken, fallback_has_prefill_claim: creditToken === null ? null : false }
        : REFUSAL_DETAILS,
    usage: {
      input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null,
      fallback_credit: redeeming ? { status: { type: "redeemed" } } : null,
    },
  };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request: Request): Promise<Response> {
    const url: URL = new URL(request.url);
    const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming =
      await request.json() as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    const beta: string | null = request.headers.get("anthropic-beta");
    captured.push({ path: `${url.pathname}${url.search}`, beta, body });
    const kind: ReplyKind = replies.shift() ?? "text";
    if (kind === "bad-request") {
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, { status: 400 });
    }
    return Response.json(messageJson(kind, {
      model: body.model,
      creditBeta: beta?.includes(CREDIT_BETA) === true,
      redeeming: "fallback_credit_token" in body,
    }));
  },
});

const PRELOADED: AgentDeploymentConfig = getAgentDeploymentConfig();

function capability(fallbackModel: string | undefined): AnthropicAgentCapabilityConfig {
  return {
    provider: "anthropic", apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.port}`, headers: undefined,
    model: PRIMARY, fallbackModel,
  };
}

function summarize(): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "summary",
    buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
      model: PRIMARY,
      system: "总结",
      messages: [{ role: "user", content: "待总结" }],
      max_tokens: 64,
    }),
    errorLabel: "Test summary",
    normalize: (text: string): string => text,
  });
}

beforeEach(() => {
  captured.length = 0;
  replies.length = 0;
  reported.length = 0;
  echoedModelSuffix = "";
  loggerWarn.mockClear();
  loggerError.mockClear();
  anthropicClientCache.current = null;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});

afterEach(() => {
  installAiCacheUsageSink(null);
  adoptAgentDeploymentConfig(PRELOADED);
  anthropicClientCache.current = null;
});

afterAll(() => server.stop(true));

describe("没有 fallback_model", () => {
  test("拒答只发一次请求，按不可重采样的 refused 交回", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(undefined) });
    replies.push("refusal");
    expect(await summarize()).toEqual({ ok: false, retryable: false, refused: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.path).toBe("/v1/messages?beta=true");
    expect(captured[0]!.beta).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(
      `Test summary returned an unusable response: model=${PRIMARY}, stop_reason=refusal, ` +
      `details=${JSON.stringify(REFUSAL_DETAILS)} (hasPartialText=false).`
    );
  });
});

describe("配置了 fallback_model", () => {
  test("拒答后以回退模型重发同一请求体并兑换额度令牌，交回回退模型的正文，用量记回退模型并记改道日志", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(FALLBACK) });
    replies.push("refusal", "text");
    expect(await summarize()).toEqual({ ok: true, text: `${FALLBACK} 正文` });
    expect(captured.map((request: CapturedRequest): string => request.body.model)).toEqual([PRIMARY, FALLBACK]);
    expect(captured[1]!.body).toEqual({
      ...captured[0]!.body, model: FALLBACK, fallback_credit_token: { token: CREDIT_TOKEN, mode: "best_effort" },
    });
    for (const request of captured) {
      expect(request.path).toBe("/v1/messages?beta=true");
      expect(request.beta).toContain(CREDIT_BETA);
    }
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ capability: "summary", provider: "anthropic", model: FALLBACK });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0]?.[0])).toStartWith(`Test summary fell back after a refusal: from=${PRIMARY}, to=${FALLBACK}, trigger=`);
    expect(String(loggerWarn.mock.calls[0]?.[0])).toEndWith(`, fallback_credit=${JSON.stringify({ status: { type: "redeemed" } })}.`);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("拒答不带额度令牌时，回退请求是只换了 model 的同一请求体", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(FALLBACK) });
    replies.push("refusal-no-credit", "text");
    expect(await summarize()).toEqual({ ok: true, text: `${FALLBACK} 正文` });
    expect(captured[1]!.body).toEqual({ ...captured[0]!.body, model: FALLBACK });
  });

  test("回退模型也拒答时按 refused 交回，共两次请求，记改道 warn，日志里的 stop_details 不含额度令牌", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(FALLBACK) });
    replies.push("refusal", "refusal");
    expect(await summarize()).toEqual({ ok: false, retryable: false, refused: true });
    expect(captured).toHaveLength(2);
    expect(loggerWarn).toHaveBeenCalledWith(
      `Test summary fell back after a refusal: from=${PRIMARY}, to=${FALLBACK}; the fallback model returned stop_reason=refusal.`
    );
    const unusable: string = String(loggerError.mock.calls[0]?.[0]);
    expect(unusable).toContain(`model=${FALLBACK}, stop_reason=refusal`);
    expect(unusable).toContain(`details=${JSON.stringify({ ...REFUSAL_DETAILS, fallback_has_prefill_claim: false })}`);
    expect(unusable).not.toContain(CREDIT_TOKEN);
  });

  test("回退请求失败时记改道 warn 与请求错误，按请求失败交回", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(FALLBACK) });
    replies.push("refusal", "bad-request");
    expect(await summarize()).toEqual({ ok: false, retryable: false });
    expect(captured).toHaveLength(2);
    expect(loggerWarn).toHaveBeenCalledWith(
      `Test summary fell back after a refusal: from=${PRIMARY}, to=${FALLBACK}; the fallback request did not complete.`
    );
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  test("端点把模型名回显成规范 ID 时，用量仍记配置里的写法", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, summary: capability(FALLBACK) });
    echoedModelSuffix = "-20261001";
    replies.push("refusal", "text");
    expect(await summarize()).toEqual({ ok: true, text: `${FALLBACK} 正文` });
    expect(reported.map((usage: AiCacheUsage): string => usage.model)).toEqual([FALLBACK]);
  });

  test("回复会话改道后，同一会话的后续请求直接发给回退模型；新会话重新从 model 起发", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, text: capability(FALLBACK) });
    const request: AiReplyTurnRequest = { systemPrompt: "系统提示词", functions: [], webSearchEnabled: false, grounded: false };
    replies.push("refusal", "tool", "text", "text");
    const session: AiReplySession = createAnthropicReplySession({ chatId: -1001, stableBlocks: ["记忆"], volatileBlocks: ["转录"] });
    const first: AiReplyTurn = await session.request(request);
    expect(first).toMatchObject({ ok: true, functionCalls: [{ id: "tu_1", name: "send_message" }] });
    expect(session.appendToolOutputs([{ call: first.functionCalls[0]!, responseJson: "{}" }])).toBeTrue();
    expect(await session.request(request)).toMatchObject({ ok: true, text: `${FALLBACK} 正文` });
    expect(await createAnthropicReplySession({ chatId: -1001, stableBlocks: ["记忆"], volatileBlocks: ["转录"] }).request(request))
      .toMatchObject({ ok: true, text: `${PRIMARY} 正文` });

    expect(captured.map((entry: CapturedRequest): string => entry.body.model)).toEqual([PRIMARY, FALLBACK, FALLBACK, PRIMARY]);
    expect(reported.map((usage: AiCacheUsage): string => usage.model)).toEqual([FALLBACK, FALLBACK, PRIMARY]);
    // 改道后的工具往返把首轮 content（含 fallback 块）写进历史；发出的请求体里不得再带 fallback 块。
    expect(JSON.stringify(captured[2]!.body.messages)).toContain("tool_result");
    expect(JSON.stringify(captured[2]!.body.messages)).not.toContain(`"type":"fallback"`);
    // 会话已钉在回退项：后续请求直接发给回退模型，不再记改道 warn。
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });
});
