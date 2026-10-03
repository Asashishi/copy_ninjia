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
import type { AiReplySession, AiReplyTurn, AiReplyTurnRequest, AiToolDefinition } from "../../../packages/types/aiChat/provider";
import { DUPLICATE_REPLY_RESULT } from "../../../packages/consts/aiChat/tools";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { SEND_MESSAGE_TOOL } from "../../../packages/consts/tools";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import type { AiCacheUsage } from "../../../packages/types/aiCache";

const requestGeminiResult = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => ({
  ok: false,
  failureKind: "request",
}));

mock.module("../../../packages/aiChat/gemini/client", () => ({ requestGeminiResult }));

/** 共用显式缓存默认取不到，第 1 次请求照常走完整结构；专门的用例再改返回值。 */
const acquireGeminiContextCache = mock((..._args: unknown[]): string | null => null);
const releaseGeminiContextCache = mock((..._args: unknown[]): void => {});
/** 内容构造原样透传，断言直接看回复会话交给缓存的字段。 */
const geminiContextCacheContent = mock((params: object): object => params);
/** text scope 的替身；只核对回复会话把它原样交给核心。 */
const TEXT_SCOPE: object = { label: "text scope" };
mock.module("../../../packages/infra/geminiContextCache", () => ({
  acquireGeminiContextCache,
  geminiContextCacheContent,
  releaseGeminiContextCache,
}));
mock.module("../../../packages/aiChat/gemini/contextCache", () => ({
  TEXT_GEMINI_CONTEXT_CACHE_SCOPE: TEXT_SCOPE,
}));

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
  requestGeminiResult.mockReset();
  requestGeminiResult.mockImplementation(async (): Promise<GeminiRequestResult> => ({
    ok: false,
    failureKind: "request",
  }));
  acquireGeminiContextCache.mockReset();
  acquireGeminiContextCache.mockImplementation((): string | null => null);
  releaseGeminiContextCache.mockClear();
  builtBodies.length = 0;
});

/** 像真实 requestGeminiResult 一样在调用时拼请求体，记下拼出的请求体后交回 result。 */
const builtBodies: GenerateContentParameters[] = [];
function respond(result: GeminiRequestResult): (...args: unknown[]) => Promise<GeminiRequestResult> {
  return async (...args: unknown[]): Promise<GeminiRequestResult> => {
    builtBodies.push((args[1] as () => GenerateContentParameters)());
    return result;
  };
}

/** 第 index 次 requestGeminiResult 调用实际拼出的请求体。 */
function bodyAt(index: number): GenerateContentParameters {
  return builtBodies[index]!;
}

describe("两套请求结构", () => {
  const REQUEST: AiReplyTurnRequest = { systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: true, grounded: false };

  test("第 1 次请求引用共用显式缓存：只发 contents，不带 systemInstruction、tools 与 toolConfig", async () => {
    acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
    requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    await session.request(REQUEST);

    const body: GenerateContentParameters = bodyAt(0);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "参考记忆" }] },
      { role: "user", parts: [{ text: "转录" }] },
    ]);
    expect(body.config?.cachedContent).toBe("cachedContents/shared");
    expect(body.config?.systemInstruction).toBeUndefined();
    expect(body.config?.tools).toBeUndefined();
    expect(body.config?.toolConfig).toBeUndefined();
    expect(acquireGeminiContextCache).toHaveBeenCalledWith(TEXT_SCOPE, expect.objectContaining({
      model: getAgentDeploymentConfig().text.model,
      systemInstruction: "系统提示词",
      toolConfig: { includeServerSideToolInvocations: true },
    }));
  });

  test("第 2 次起换回完整结构，contents 与模型 content（含思考签名）照常接回，不再取缓存", async () => {
    acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
    requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);
    session.appendToolOutputs([{ call: turn.functionCalls[0]!, responseJson: "{\"success\":true}" }]);
    await session.request(REQUEST);

    const second: GenerateContentParameters = bodyAt(1);
    expect(second.config?.cachedContent).toBeUndefined();
    expect(second.config?.systemInstruction).toBe("系统提示词");
    expect(second.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
    expect((second.contents as Content[])[2]).toEqual(modelContent());
    expect(acquireGeminiContextCache).toHaveBeenCalledTimes(1);
  });

  test("缓存被端点拒绝时释放登记，并按完整结构补发一次", async () => {
    acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/gone");
    requestGeminiResult.mockImplementationOnce(respond({
      ok: false,
      failureKind: "misconfigured",
    }));
    requestGeminiResult.mockImplementationOnce(respond(okResult(modelContent(), "好")));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);

    expect(turn.ok).toBe(true);
    expect(releaseGeminiContextCache).toHaveBeenCalledWith(TEXT_SCOPE, "cachedContents/gone");
    expect(requestGeminiResult).toHaveBeenCalledTimes(2);
    expect(bodyAt(1).config?.cachedContent).toBeUndefined();
    expect(bodyAt(1).config?.systemInstruction).toBe("系统提示词");
  });

  test("端点故障不补发，也不释放缓存登记", async () => {
    acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
    requestGeminiResult.mockImplementation(respond({ ok: false, failureKind: "request" }));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);

    expect(turn.ok).toBe(false);
    expect(requestGeminiResult).toHaveBeenCalledTimes(1);
    expect(releaseGeminiContextCache).not.toHaveBeenCalled();
  });
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
    // 校验 functionDeclarations[0] 与 SEND_MESSAGE 引用相同（buildTools 按引用透传声明）。
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

describe("Gemini 回复会话的检索计量", () => {
  test("失败分支仍交回已执行的检索次数，会话不重复上报用量", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
    try {
      requestGeminiResult.mockImplementation(respond({
        ok: false,
        failureKind: "response",
        finishReason: "MAX_TOKENS",
        response: {
          candidates: [{ finishReason: "MAX_TOKENS", groundingMetadata: { webSearchQueries: ["a", "b"] } }],
        } as never,
      } as GeminiRequestResult));
      const session: AiReplySession = createGeminiReplySession({ stableBlocks: [], volatileBlocks: ["区块"] });
      const turn: AiReplyTurn = await session.request({
        systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: true, grounded: false,
      });
      expect(turn.webSearchCalls).toBe(2);
      expect(reported).toEqual([]);
    } finally {
      installAiCacheUsageSink(null);
    }
  });
});

describe("Gemini 回复会话的对话记录累积", () => {
  test("重复跳过回执只追加，隐式缓存前缀和思考签名保持不变", async () => {
    const content: Content = modelContent();
    requestGeminiResult.mockResolvedValueOnce(okResult(content));
    const session: AiReplySession = createGeminiReplySession({ stableBlocks: ["参考记忆"], volatileBlocks: ["当前会话"] });
    const request: AiReplyTurnRequest = {
      systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: true, grounded: false,
    };
    const turn: AiReplyTurn = await session.request(request);
    const before: GenerateContentParameters = structuredClone(
      (requestGeminiResult.mock.calls[0]![1] as () => GenerateContentParameters)()
    );
    expect(session.appendToolOutputs([{ call: turn.functionCalls[0]!, responseJson: DUPLICATE_REPLY_RESULT }])).toBe(true);

    await session.request(request);
    const after: GenerateContentParameters = (requestGeminiResult.mock.calls[1]![1] as () => GenerateContentParameters)();
    expect(after.config).toEqual(before.config);
    expect(after.config?.cachedContent).toBeUndefined();
    expect(after.contents).toEqual([
      ...before.contents as Content[],
      content,
      { role: "user", parts: [{ functionResponse: {
        id: "call-1", name: SEND_MESSAGE_TOOL, response: { success: true, skipped: "duplicate", actions_used: 0 },
      } }] },
    ]);
    expect((after.contents as Content[])[2]).toBe(content);
  });

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
      { id: "call-1", name: SEND_MESSAGE_TOOL, argumentsJson: JSON.stringify({ text: "你好" }) },
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
      parts: [{ functionResponse: { id: "call-1", name: SEND_MESSAGE_TOOL, response: { success: true } } }],
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
