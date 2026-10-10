/**
 * Gemini 回复会话：中立请求到 generateContent 请求体的映射，以及多轮工具往返
 * 的对话记录累积。
 *
 * 覆盖：上一轮模型的整个 content（含 thought signature）原样接回，服务端检索调用在失败分支也计数，
 * 以及第 1 次请求按本群上一次触发间隔在显式缓存与隐式前缀缓存之间切换。
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import type { Content, GenerateContentParameters } from "@google/genai";
import type { GeminiRequestResult } from "../../../packages/types/aiChat/gemini";
import type { GeminiRequestOptions } from "../../../packages/aiChat/gemini/client";
import type { AiReplySession, AiReplyTurn, AiReplyTurnRequest, AiToolDefinition } from "../../../packages/types/aiChat/provider";
import { DUPLICATE_REPLY_RESULT } from "../../../packages/consts/aiChat/tools";
import {
  geminiReplyLastRequestAt,
  resetGeminiContextCache,
  sweepGeminiReplyRequestTimes,
} from "../../../packages/cache/workers/aiChat/geminiContextCache";
import { invalidateChatRuntimeCache } from "../../../packages/cache/workers/aiChat/index";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { agentDeploymentConfigCache } from "../../../packages/cache/perThread/config";
import { SEND_MESSAGE_TOOL } from "../../../packages/consts/tools";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import type { AiCacheUsage } from "../../../packages/types/aiCache";

const requestGeminiResult = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => ({
  ok: false,
  failureKind: "request",
}));

/** 按群记录触发时刻的用例所用的夹具群 ID；其余用例不给 chatId。 */
const CHAT_ID: number = -100_100;
const OTHER_CHAT_ID: number = -100_200;

/** 会话创建时固定的客户端替身；请求经被替换的 requestGeminiResult 发出，不触达它。 */
const PINNED_CLIENT: object = { label: "pinned gemini client" };
const getGeminiClient = mock((..._args: unknown[]): object => PINNED_CLIENT);
mock.module("../../../packages/aiChat/gemini/client", () => ({ getGeminiClient, requestGeminiResult }));

/** 共用显式缓存默认取不到，首次请求照常走完整结构；专门的用例再改返回值。 */
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
  GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
  GEMINI_SERVER_TOOL_CONFIG,
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
  resetGeminiContextCache();
});

/** 像真实 requestGeminiResult 一样在调用时拼请求体，记下拼出的请求体后交回 result。 */
const builtBodies: GenerateContentParameters[] = [];
function respond(result: GeminiRequestResult): (...args: unknown[]) => Promise<GeminiRequestResult> {
  return async (...args: unknown[]): Promise<GeminiRequestResult> => {
    builtBodies.push((args[0] as GeminiRequestOptions).buildBody());
    return result;
  };
}

/** 第 index 次 requestGeminiResult 调用实际拼出的请求体。 */
function bodyAt(index: number): GenerateContentParameters {
  return builtBodies[index]!;
}

describe("Gemini 回复会话的热重载边界", () => {
  test("会话创建时固定模型与客户端：工具往返之间热重载 text 配置，后续请求仍用旧模型与旧客户端", async () => {
    const original = agentDeploymentConfigCache.current!;
    requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    const request: AiReplyTurnRequest = { systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: false, grounded: false };
    const first: AiReplyTurn = await session.request(request);
    expect(session.appendToolOutputs([{ call: first.functionCalls[0]!, responseJson: DUPLICATE_REPLY_RESULT }])).toBeTrue();
    try {
      agentDeploymentConfigCache.current = { ...original, text: { ...original.text, model: "reloaded-model" } };
      await session.request(request);
    } finally {
      agentDeploymentConfigCache.current = original;
    }

    expect(builtBodies.map((body: GenerateContentParameters): string => body.model)).toEqual([original.text.model, original.text.model]);
    for (const call of requestGeminiResult.mock.calls) {
      expect((call[0] as GeminiRequestOptions).client).toBe(PINNED_CLIENT as never);
    }
  });

  test("创建后、第 1 次请求前配置被热重载时不引用共用显式缓存，直接发完整请求", async () => {
    const original = agentDeploymentConfigCache.current!;
    acquireGeminiContextCache.mockReturnValue("cachedContents/shared");
    requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    try {
      agentDeploymentConfigCache.current = { ...original, text: { ...original.text } };
      await session.request({ systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: false, grounded: false });
    } finally {
      agentDeploymentConfigCache.current = original;
      acquireGeminiContextCache.mockReturnValue(null);
    }

    expect(acquireGeminiContextCache).not.toHaveBeenCalled();
    expect(bodyAt(0).config?.cachedContent).toBeUndefined();
    expect(bodyAt(0).config?.systemInstruction).toBe("系统提示词");
  });
});

describe("两套请求结构", () => {
  const REQUEST: AiReplyTurnRequest = { systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: true, grounded: false };

  test("本群还没有过回复请求时，第 1 次请求引用共用显式缓存：只发 contents，不带 systemInstruction、tools 与 toolConfig", async () => {
    acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
    requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
    const turn: AiReplyTurn = await session.request(REQUEST);

    expect(turn.ok).toBe(false);
    expect(requestGeminiResult).toHaveBeenCalledTimes(1);
    expect(releaseGeminiContextCache).not.toHaveBeenCalled();
  });

  test("距本群上一次触发不超过阈值（含相等）时，第 1 次请求不取显式缓存，发送完整结构", async () => {
    const now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockReturnValue(now);
    try {
      geminiReplyLastRequestAt.set(CHAT_ID, now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS);
      acquireGeminiContextCache.mockReturnValue("cachedContents/shared");
      requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
      const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      await session.request(REQUEST);

      expect(acquireGeminiContextCache).not.toHaveBeenCalled();
      expect(bodyAt(0).config?.cachedContent).toBeUndefined();
      expect(bodyAt(0).config?.systemInstruction).toBe("系统提示词");
      expect(bodyAt(0).config?.tools).toBeDefined();
      expect(bodyAt(0).config?.toolConfig).toEqual(GEMINI_SERVER_TOOL_CONFIG);
      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });

  test("距本群上一次触发超过阈值时，第 1 次请求引用显式缓存", async () => {
    const now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockReturnValue(now);
    try {
      geminiReplyLastRequestAt.set(CHAT_ID, now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS - 1);
      acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
      requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
      const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      await session.request(REQUEST);

      expect(bodyAt(0).config?.cachedContent).toBe("cachedContents/shared");
      expect(bodyAt(0).config?.systemInstruction).toBeUndefined();
      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });

  test("失败的请求不写入触发时刻", async () => {
    const now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockReturnValue(now);
    try {
      const recordedAt: number = now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS;
      geminiReplyLastRequestAt.set(CHAT_ID, recordedAt);
      requestGeminiResult.mockImplementation(respond({ ok: false, failureKind: "request" }));
      const warm: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      const cold: AiReplySession = createGeminiReplySession({ chatId: OTHER_CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      const warmTurn: AiReplyTurn = await warm.request(REQUEST);
      const coldTurn: AiReplyTurn = await cold.request(REQUEST);

      expect(warmTurn.ok).toBe(false);
      expect(coldTurn.ok).toBe(false);
      expect(acquireGeminiContextCache).toHaveBeenCalledTimes(1);
      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(recordedAt);
      expect(geminiReplyLastRequestAt.has(OTHER_CHAT_ID)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test("并行请求乱序完成时，较早发出的请求不覆盖较晚的触发时刻", async () => {
    let now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockImplementation((): number => now);
    try {
      const settle: ((result: GeminiRequestResult) => void)[] = [];
      requestGeminiResult.mockImplementation((...args: unknown[]): Promise<GeminiRequestResult> => {
        builtBodies.push((args[0] as GeminiRequestOptions).buildBody());
        return new Promise((resolve: (result: GeminiRequestResult) => void): void => {
          settle.push(resolve);
        });
      });
      const earlier: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      const later: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      const earlierTurn: Promise<AiReplyTurn> = earlier.request(REQUEST);
      now += 1_000;
      const laterTurn: Promise<AiReplyTurn> = later.request(REQUEST);

      settle[1]!(okResult(modelContent()));
      await laterTurn;
      settle[0]!(okResult(modelContent()));
      await earlierTurn;

      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });

  test("后续请求刷新触发时刻：阈值内的新会话走隐式，超过阈值再走显式", async () => {
    let now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockImplementation((): number => now);
    try {
      acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
      requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
      const blocks: { chatId: number; stableBlocks: string[]; volatileBlocks: string[] } = {
        chatId: CHAT_ID,
        stableBlocks: ["参考记忆"],
        volatileBlocks: ["转录"],
      };
      const first: AiReplySession = createGeminiReplySession(blocks);
      await first.request(REQUEST);
      now += GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS + 1;
      await first.request(REQUEST);
      expect(bodyAt(1).config?.cachedContent).toBeUndefined();
      expect(bodyAt(1).config?.systemInstruction).toBe("系统提示词");
      expect(acquireGeminiContextCache).toHaveBeenCalledTimes(1);

      now += 1;
      const second: AiReplySession = createGeminiReplySession(blocks);
      await second.request(REQUEST);
      expect(acquireGeminiContextCache).toHaveBeenCalledTimes(1);
      expect(bodyAt(2).config?.systemInstruction).toBe("系统提示词");
      expect(bodyAt(2).config?.cachedContent).toBeUndefined();

      now += GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS + 1;
      const third: AiReplySession = createGeminiReplySession(blocks);
      await third.request(REQUEST);
      expect(acquireGeminiContextCache).toHaveBeenCalledTimes(2);
      expect(bodyAt(3).config?.cachedContent).toBe("cachedContents/shared");
    } finally {
      clock.mockRestore();
    }
  });

  test("显式缓存被拒后的补发把触发时刻写成补发当时", async () => {
    let now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockImplementation((): number => now);
    try {
      acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/gone");
      requestGeminiResult.mockImplementationOnce(async (...args: unknown[]): Promise<GeminiRequestResult> => {
        builtBodies.push((args[0] as GeminiRequestOptions).buildBody());
        now += GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS + 1;
        return { ok: false, failureKind: "misconfigured" };
      });
      requestGeminiResult.mockImplementationOnce(async (...args: unknown[]): Promise<GeminiRequestResult> => {
        builtBodies.push((args[0] as GeminiRequestOptions).buildBody());
        return okResult(modelContent(), "好");
      });
      const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      const turn: AiReplyTurn = await session.request(REQUEST);

      expect(turn.ok).toBe(true);
      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(now);
      expect(bodyAt(1).config?.systemInstruction).toBe("系统提示词");
    } finally {
      clock.mockRestore();
    }
  });

  test("其它群在阈值内的触发不影响本群：第 1 次请求仍引用显式缓存", async () => {
    const now: number = 5_000_000_000;
    const clock: Mock<() => number> = spyOn(performance, "now").mockReturnValue(now);
    try {
      geminiReplyLastRequestAt.set(OTHER_CHAT_ID, now);
      acquireGeminiContextCache.mockImplementation((): string | null => "cachedContents/shared");
      requestGeminiResult.mockImplementation(respond(okResult(modelContent())));
      const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录"] });
      await session.request(REQUEST);

      expect(bodyAt(0).config?.cachedContent).toBe("cachedContents/shared");
      expect(geminiReplyLastRequestAt.get(CHAT_ID)).toBe(now);
      expect(geminiReplyLastRequestAt.get(OTHER_CHAT_ID)).toBe(now);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("按群记录的触发时刻", () => {
  test("按群失效只删除本群的触发时刻", () => {
    geminiReplyLastRequestAt.set(CHAT_ID, 1);
    geminiReplyLastRequestAt.set(OTHER_CHAT_ID, 2);
    invalidateChatRuntimeCache(CHAT_ID);

    expect(geminiReplyLastRequestAt.has(CHAT_ID)).toBe(false);
    expect(geminiReplyLastRequestAt.get(OTHER_CHAT_ID)).toBe(2);
  });

  test("维护清扫只删除已超过阈值的触发时刻，恰好等于阈值的保留", () => {
    const now: number = 1_000_000;
    geminiReplyLastRequestAt.set(CHAT_ID, now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS - 1);
    geminiReplyLastRequestAt.set(OTHER_CHAT_ID, now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS);
    sweepGeminiReplyRequestTimes(now);

    expect(geminiReplyLastRequestAt.has(CHAT_ID)).toBe(false);
    expect(geminiReplyLastRequestAt.get(OTHER_CHAT_ID)).toBe(now - GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS);
  });
});

describe("Gemini 回复会话的请求映射", () => {
  test("初始上下文按稳定区块在前、易变区块在后的两个 user 轮次映射", async () => {
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["区块一"], volatileBlocks: ["区块二", "区块三"] });
    await session.request({
      systemPrompt: "系统提示词",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });

    const body: GenerateContentParameters = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
    expect((requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).capability).toBe("text");
    expect(body.model).toBe(getAgentDeploymentConfig().text.model);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "区块一" }] },
      { role: "user", parts: [{ text: "区块二" }, { text: "区块三" }] },
    ]);
    expect(body.config?.systemInstruction).toBe("系统提示词");
  });

  test("采样温度与 token 上限取自本包 consts，未查证轮用常规温度", async () => {
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
    expect(body.config?.temperature).toBe(GEMINI_REPLY_TEMPERATURE);
    expect(body.config?.maxOutputTokens).toBe(GEMINI_REPLY_MAX_TOKENS);
  });

  test("已查证轮压低采样随机性，让模型照搜索结果讲", async () => {
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: true,
    });

    const body = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
    expect(body.config?.temperature).toBe(GEMINI_GROUNDED_REPLY_TEMPERATURE);
  });

  test("开检索时挂 googleSearch 并要求接回服务端调用记录", async () => {
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    await session.request({
      systemPrompt: "s",
      functions: [],
      webSearchEnabled: false,
      grounded: false,
    });

    const body = (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody();
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
      const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: [], volatileBlocks: ["区块"] });
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["当前会话"] });
    const request: AiReplyTurnRequest = {
      systemPrompt: "系统提示词", functions: [SEND_MESSAGE], webSearchEnabled: true, grounded: false,
    };
    const turn: AiReplyTurn = await session.request(request);
    const before: GenerateContentParameters = structuredClone(
      (requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions).buildBody()
    );
    expect(session.appendToolOutputs([{ call: turn.functionCalls[0]!, responseJson: DUPLICATE_REPLY_RESULT }])).toBe(true);

    await session.request(request);
    const after: GenerateContentParameters = (requestGeminiResult.mock.calls[1]![0] as GeminiRequestOptions).buildBody();
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

    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
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
    const body = (requestGeminiResult.mock.calls[1]![0] as GeminiRequestOptions).buildBody();
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["转录", "运行时状态", "回复任务"] });
    for (let round: number = 0; round < 2; round += 1) {
      await session.request({
        systemPrompt: "系统提示词",
        functions: [SEND_MESSAGE],
        webSearchEnabled: true,
        grounded: false,
      });
    }

    for (const call of requestGeminiResult.mock.calls) {
      const body: GenerateContentParameters = (call[0] as GeminiRequestOptions).buildBody();
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

    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
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
    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
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

  test("请求失败时把服务端工具调用超限与收尾详情显式带回上层", async () => {
    requestGeminiResult.mockResolvedValueOnce({
      ok: false,
      failureKind: "response",
      finishReason: "TOO_MANY_TOOL_CALLS",
      finishDetails: "{\"finishMessage\":\"limit\"}",
      response: {
        candidates: [{ finishReason: "TOO_MANY_TOOL_CALLS", content: { role: "model", parts: [] } }],
      },
    } as unknown as GeminiRequestResult);

    const session: AiReplySession = createGeminiReplySession({ chatId: CHAT_ID, stableBlocks: ["参考记忆"], volatileBlocks: ["区块"] });
    const turn = await session.request({
      systemPrompt: "s",
      functions: [SEND_MESSAGE],
      webSearchEnabled: true,
      grounded: false,
    });
    expect(turn.ok).toBe(false);
    expect(turn.toolCallLimitHit).toBe(true);
    expect(turn.finishDetails).toBe("{\"finishMessage\":\"limit\"}");
    expect(turn.text).toBeNull();
    expect(turn.functionCalls).toEqual([]);
  });
});
