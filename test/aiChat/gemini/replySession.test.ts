/**
 * Gemini 回复会话：中立请求到 generateContent 请求体的映射，以及多轮工具往返
 * 的对话记录累积。
 *
 * 重点守两条：上一轮模型的整个 content 必须原样接回（thought signature 就在
 * 里面，缺了会丢思考上下文），以及服务端检索调用在失败分支也要计数。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Content, GenerateContentParameters } from "@google/genai";
import type { GeminiRequestResult } from "../../../packages/types/aiChat/gemini";
import type { AiReplySession, AiToolDefinition } from "../../../packages/types/aiChat/provider";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";

const requestGeminiResult = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => ({
  ok: false,
  failureKind: "request",
  diagnostic: "request failed",
}));

mock.module("../../../packages/aiChat/gemini/client", () => ({ requestGeminiResult }));

const { createGeminiReplySession } = await import("../../../packages/aiChat/gemini/replySession");
const {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
} = await import("../../../packages/consts/aiChat/gemini");

const SEND_MESSAGE: AiToolDefinition = {
  name: "send_message",
  description: "发一条群消息",
  parametersJsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** 一份带 thought signature 的模型 content，用于验证原样接回。 */
function modelContent(): Content {
  return {
    role: "model",
    parts: [
      { text: "思考中", thought: true, thoughtSignature: "sig-abc" },
      { functionCall: { id: "call-1", name: "send_message", args: { text: "你好" } } },
    ],
  };
}

function okResult(content: Content, text: string = ""): GeminiRequestResult {
  return {
    ok: true,
    response: {
      candidates: [{ finishReason: "STOP", content }],
      get text(): string { return text; },
      get functionCalls() {
        return content.parts?.flatMap((part) => (part.functionCall ? [part.functionCall] : [])) ?? [];
      },
    } as unknown as GeminiRequestResult extends { ok: true; response: infer R } ? R : never,
  };
}

beforeEach(() => {
  requestGeminiResult.mockClear();
});

describe("Gemini 回复会话的请求映射", () => {
  test("初始上下文按稳定区块在前、易变区块在后的两个 user 轮次映射", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["区块一"], volatileBlocks: ["区块二", "区块三"] });
    await session.request({
      systemPrompt: "系统提示词",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });

    const body: GenerateContentParameters = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(requestGeminiResult.mock.calls[0]![0]).toBe("text");
    expect(body.model).toBe(getAgentDeploymentConfig().text.model);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "区块一" }] },
      { role: "user", parts: [{ text: "区块二" }, { text: "区块三" }] },
    ]);
    expect(body.config?.systemInstruction).toBe("系统提示词");
  });

  test("采样温度与 token 上限取自本包 consts，未查证轮用常规温度", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(body.config?.temperature).toBe(GEMINI_REPLY_TEMPERATURE);
    expect(body.config?.maxOutputTokens).toBe(GEMINI_REPLY_MAX_TOKENS);
  });

  test("已查证轮压低采样随机性，让模型照搜索结果讲", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: true,
    });

    const body = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(body.config?.temperature).toBe(GEMINI_GROUNDED_REPLY_TEMPERATURE);
  });

  test("开检索时挂 googleSearch 并要求接回服务端调用记录", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(body.config?.tools).toEqual([
      { googleSearch: {} },
      {
        functionDeclarations: [{
          name: SEND_MESSAGE.name,
          description: SEND_MESSAGE.description,
          parametersJsonSchema: SEND_MESSAGE.parametersJsonSchema,
        }],
      },
    ]);
    expect(body.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  });

  test("关检索时摘掉 googleSearch，也不再要求接回服务端调用记录", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(body.config?.tools).toEqual([{
      functionDeclarations: [{
        name: SEND_MESSAGE.name,
        description: SEND_MESSAGE.description,
        parametersJsonSchema: SEND_MESSAGE.parametersJsonSchema,
      }],
    }]);
    // 声明按引用透传，不逐字段抄成一个同构对象：这里每个工具轮跑一次，
    // 复制一遍什么新东西都没产生（见 buildTools 的注释）。
    expect((body.config?.tools?.[0] as { functionDeclarations: unknown[] }).functionDeclarations[0])
      .toBe(SEND_MESSAGE);
    expect(body.config?.toolConfig).toBeUndefined();
  });

  test("函数全被摘掉时不挂空的 functionDeclarations", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)();
    expect(body.config?.tools).toEqual([]);
  });
});

describe("Gemini 回复会话的对话记录累积", () => {
  test("上一轮模型 content 连同 thought signature 原样接回，函数结果附在其后", async () => {
    const content: Content = modelContent();
    requestGeminiResult.mockResolvedValueOnce(okResult(content));

    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    const turn = await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });
    expect(turn.functionCalls).toEqual([
      { id: "call-1", name: "send_message", argumentsJson: JSON.stringify({ text: "你好" }) },
    ]);

    expect(session.appendToolOutputs([
      { call: turn.functionCalls[0]!, responseJson: JSON.stringify({ success: true }) },
    ])).toBe(true);

    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });
    const body = (requestGeminiResult.mock.calls[1]![1] as () => GenerateContentParameters)();
    const contents = body.contents as Content[];
    // 稳定前缀排在最前，随后是易变区块、模型轮与函数结果。
    expect(contents).toHaveLength(4);
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "参考记忆" }] });
    // 模型轮次原样接回：thought signature 必须还在。
    expect(contents[2]).toBe(content);
    expect(contents[2]?.parts?.[0]?.thoughtSignature).toBe("sig-abc");
    expect(contents[3]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "call-1", name: "send_message", response: { success: true } } }],
    });
  });

  test("每轮都发送完整前缀并只使用 Gemini 隐式缓存", async () => {
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["转录", "运行时状态", "回复任务"] });
    for (let round: number = 0; round < 2; round += 1) {
      await session.request({
        systemPrompt: "系统提示词",
        functions: [SEND_MESSAGE],
        webSearchEnabled: true,
        grounded: false,
      });
    }

    for (const call of requestGeminiResult.mock.calls) {
      const body: GenerateContentParameters = (call[1] as () => GenerateContentParameters)();
      expect(body.config?.cachedContent).toBeUndefined();
      expect(body.config?.systemInstruction).toBe("系统提示词");
      expect(body.config?.tools).toBeDefined();
      expect(body.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "参考记忆" }] },
        { role: "user", parts: [{ text: "转录" }, { text: "运行时状态" }, { text: "回复任务" }] },
      ]);
      expect(body.config?.temperature).toBe(GEMINI_REPLY_TEMPERATURE);
      expect(body.config?.maxOutputTokens).toBe(GEMINI_REPLY_MAX_TOKENS);
    }
  });

  test("响应缺 content 时交不出可续接的轮次", async () => {
    requestGeminiResult.mockResolvedValueOnce({
      ok: true,
      response: {
        candidates: [{ finishReason: "STOP" }],
        get text(): string { return ""; },
        get functionCalls() { return []; },
      },
    } as unknown as GeminiRequestResult);

    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });
    expect(session.appendToolOutputs([
      { call: { id: "x", name: "send_message", argumentsJson: "{}" }, responseJson: "{}" },
    ])).toBe(false);
  });

  test("工具返回非对象 JSON 时按不变量抛错", async () => {
    requestGeminiResult.mockResolvedValueOnce(okResult(modelContent()));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });

    expect(() => session.appendToolOutputs([
      { call: { id: "call-1", name: "send_message", argumentsJson: "{}" }, responseJson: '"just a string"' },
    ])).toThrow(/non-object JSON value/);
  });

  test("请求失败时把服务端工具调用超限显式带回上层", async () => {
    requestGeminiResult.mockResolvedValueOnce({
      ok: false,
      failureKind: "response",
      diagnostic: "finishReason=TOO_MANY_TOOL_CALLS",
      finishReason: "TOO_MANY_TOOL_CALLS",
      response: {
        candidates: [{ finishReason: "TOO_MANY_TOOL_CALLS", content: { role: "model", parts: [] } }],
      },
    } as unknown as GeminiRequestResult);

    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    const turn = await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });
    expect(turn.ok).toBe(false);
    expect(turn.toolCallLimitHit).toBe(true);
    expect(turn.text).toBeNull();
    expect(turn.functionCalls).toEqual([]);
  });
});
