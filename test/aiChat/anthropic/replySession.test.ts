/**
 * Anthropic 回复会话：中立请求到 Messages 请求体的映射（内建检索挂 allowed_callers、系统提示词与
 * 最后一个稳定区块带缓存断点、自定义工具透传 Schema）、工具往返的 messages 累积、pause_turn 续发与
 * 合并，以及失败分支交回已执行的检索次数；用量由客户端响应边界上报，会话不重复记账。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicRequestResult } from "../../../packages/types/aiChat/anthropic";
import type { AiReplySession, AiReplyTurn, AiReplyTurnRequest, AiToolDefinition } from "../../../packages/types/aiChat/provider";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { agentDeploymentConfigCache } from "../../../packages/cache/perThread/config";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";

const results: AnthropicRequestResult[] = [];
const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
const requestAnthropicMessage = mock(async (...args: unknown[]): Promise<AnthropicRequestResult> => {
  bodies.push(structuredClone((args[0] as { buildBody: () => Anthropic.MessageCreateParamsNonStreaming }).buildBody()));
  return results.shift() ?? { ok: false, failureKind: "request" };
});
/** 会话创建时固定的客户端替身；请求经被替换的 requestAnthropicMessage 发出，不触达它。 */
const PINNED_CLIENT: object = { label: "pinned anthropic client" };
mock.module("../../../packages/aiChat/anthropic/client", () => ({
  getAnthropicClient: (): object => PINNED_CLIENT,
  requestAnthropicMessage,
}));

const { createAnthropicReplySession } = await import("../../../packages/aiChat/anthropic/replySession");
const {
  ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS,
  ANTHROPIC_REPLY_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} = await import("../../../packages/consts/aiChat/anthropic");

const SEND: AiToolDefinition = { name: "send_message", description: "发言", parametersJsonSchema: { type: "object", properties: { text: { type: "string" } } } };
const REQUEST: AiReplyTurnRequest = { systemPrompt: "系统提示词", functions: [SEND], webSearchEnabled: true, grounded: false };

function message(content: unknown[], stopReason: string = "end_turn", searches: number = 0): Anthropic.Message {
  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } },
  } as unknown as Anthropic.Message;
}

const reported: AiCacheUsage[] = [];
beforeEach(() => {
  results.length = 0;
  bodies.length = 0;
  requestAnthropicMessage.mockClear();
  reported.length = 0;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});
afterEach(() => installAiCacheUsageSink(null));

describe("Anthropic 回复会话的热重载边界", () => {
  test("会话创建时固定模型与客户端：工具往返之间热重载 text 配置，后续请求仍用旧模型与旧客户端", async () => {
    const original = agentDeploymentConfigCache.current!;
    results.push({ ok: true, message: message([{ type: "tool_use", id: "tu-1", name: SEND.name, input: { text: "嗨" } }], "tool_use") });
    const session: AiReplySession = createAnthropicReplySession({ stableBlocks: ["记忆"], volatileBlocks: ["转录"] });
    const first: AiReplyTurn = await session.request(REQUEST);
    expect(session.appendToolOutputs([{ call: first.functionCalls[0]!, responseJson: "{}" }])).toBeTrue();
    try {
      agentDeploymentConfigCache.current = { ...original, text: { ...original.text, model: "reloaded-model" } };
      await session.request(REQUEST);
    } finally {
      agentDeploymentConfigCache.current = original;
    }

    expect(bodies.map((body: Anthropic.MessageCreateParamsNonStreaming): string => body.model))
      .toEqual([original.text.model, original.text.model]);
    for (const call of requestAnthropicMessage.mock.calls) {
      expect((call[0] as { client?: unknown }).client).toBe(PINNED_CLIENT);
    }
  });
});

describe("Anthropic 回复会话", () => {
  test("请求体：内建检索在前且只许直接调用，自定义工具透传 Schema；系统提示词、最后一个稳定区块与请求顶层带缓存断点，不带温度", async () => {
    results.push({ ok: true, message: message([{ type: "text", text: "好" }]) });
    const session: AiReplySession = createAnthropicReplySession({ stableBlocks: ["记忆一", "记忆二"], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);

    expect(turn).toMatchObject({ ok: true, text: "好", functionCalls: [], webSearchCalls: 0 });
    expect(bodies[0] as unknown).toEqual({
      model: getAgentDeploymentConfig().text.model,
      system: [{ type: "text", text: "系统提示词", cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "记忆一" },
          { type: "text", text: "记忆二", cache_control: { type: "ephemeral" } },
          { type: "text", text: "转录" },
        ],
      }],
      tools: [
        { type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] },
        { name: SEND.name, description: SEND.description, input_schema: SEND.parametersJsonSchema },
      ],
      max_tokens: ANTHROPIC_REPLY_MAX_TOKENS,
      cache_control: { type: "ephemeral" },
    });
  });

  test("当前会话按已定切点切成多个文本块，最后一个已定段带缓存断点，拼起来与原区块逐字相同", async () => {
    results.push({ ok: true, message: message([{ type: "text", text: "好" }]) });
    const conversation: string = "第一格\n第二格\n未定的最新格";
    const offsets: readonly number[] = [conversation.indexOf("\n第二格"), conversation.indexOf("\n未定")];
    const session: AiReplySession = createAnthropicReplySession({
      stableBlocks: ["记忆"],
      volatileBlocks: [conversation, "运行时状态"],
      conversationSettledOffsets: offsets,
    });
    await session.request(REQUEST);

    const content = bodies[0]!.messages[0]!.content as Anthropic.TextBlockParam[];
    expect(content).toEqual([
      { type: "text", text: "记忆", cache_control: { type: "ephemeral" } },
      { type: "text", text: "第一格" },
      { type: "text", text: "\n第二格", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n未定的最新格" },
      { type: "text", text: "运行时状态" },
    ]);
    expect(content.slice(1, 4).map((block: Anthropic.TextBlockParam): string => block.text).join("")).toBe(conversation);
    // 系统提示词、参考记忆、已定段与顶层自动断点合计不超过端点的缓存断点上限。
    const markers: number = content.filter((block: Anthropic.TextBlockParam): boolean => block.cache_control !== undefined).length +
      (bodies[0]!.system as Anthropic.TextBlockParam[]).length + (bodies[0]!.cache_control === undefined ? 0 : 1);
    expect(markers).toBe(4);
  });

  test("工具往返：assistant 内容原样接回，再挂一条带 tool_result 的 user 消息；检索次数交回预算，会话不重复上报用量", async () => {
    const assistant: unknown[] = [
      { type: "server_tool_use", id: "srv", name: "web_search", input: { query: "q" } },
      { type: "tool_use", id: "call-1", name: "send_message", input: { text: "你好" } },
    ];
    results.push({ ok: true, message: message(assistant, "tool_use", 1) }, { ok: true, message: message([{ type: "text", text: "完" }]) });
    const session: AiReplySession = createAnthropicReplySession({ stableBlocks: [], volatileBlocks: ["转录"] });
    const first: AiReplyTurn = await session.request(REQUEST);
    expect(first.functionCalls).toEqual([{ id: "call-1", name: "send_message", argumentsJson: "{\"text\":\"你好\"}" }]);
    expect(first.webSearchCalls).toBe(1);
    expect(session.appendToolOutputs([{ call: first.functionCalls[0]!, responseJson: "{\"success\":true}" }])).toBeTrue();
    await session.request(REQUEST);

    expect(bodies[1]!.messages.slice(1) as unknown).toEqual([
      { role: "assistant", content: assistant },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"success\":true}" }] },
    ]);
    expect(reported).toEqual([]);
    // 没有可续接的 assistant 轮次时拒绝追加。
    expect(session.appendToolOutputs([])).toBeTrue();
    expect(session.appendToolOutputs([])).toBeFalse();
  });

  test("pause_turn：已得内容作为续写前缀再发，续出内容与前缀合并成同一个 assistant 轮次", async () => {
    const paused: unknown[] = [
      { type: "text", text: "前半" },
      { type: "server_tool_use", id: "srv", name: "web_search", input: { query: "q" } },
    ];
    const rest: unknown[] = [
      { type: "text", text: "后半" },
      { type: "tool_use", id: "call-1", name: "send_message", input: {} },
    ];
    results.push({ ok: true, message: message(paused, "pause_turn", 1) }, { ok: true, message: message(rest, "tool_use", 1) });
    const session: AiReplySession = createAnthropicReplySession({ stableBlocks: [], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);

    expect(turn.webSearchCalls).toBe(2);
    expect(turn.text).toBe("前半后半");
    expect(bodies[1]!.messages.at(-1) as unknown).toEqual({ role: "assistant", content: paused });
    session.appendToolOutputs([{ call: turn.functionCalls[0]!, responseJson: "{}" }]);
    results.push({ ok: true, message: message([{ type: "text", text: "完" }]) });
    await session.request(REQUEST);
    expect(bodies[2]!.messages[1] as unknown).toEqual({ role: "assistant", content: [...paused, ...rest] });
  });

  test("续发用尽仍暂停按失败收尾；请求失败时已执行的检索照样计入", async () => {
    for (let index: number = 0; index <= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS; index++) {
      results.push({ ok: true, message: message([], "pause_turn", 1) });
    }
    const session: AiReplySession = createAnthropicReplySession({ stableBlocks: [], volatileBlocks: ["转录"] });
    expect(await session.request(REQUEST)).toMatchObject({ ok: false, finishReason: "pause_turn", webSearchCalls: ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS + 1 });

    results.push({ ok: false, failureKind: "response", stopReason: "max_tokens", message: message([], "max_tokens", 2) });
    expect(await session.request(REQUEST)).toMatchObject({ ok: false, finishReason: "max_tokens", webSearchCalls: 2, toolCallLimitHit: false });
  });
});
