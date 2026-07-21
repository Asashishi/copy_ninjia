import { beforeEach, expect, mock, test } from "bun:test";
import type { GenerateContentParameters, GenerateContentResponse, Tool } from "@google/genai";
import type { ReplyToolset } from "../../src/types";
import type { GeminiRequestResult } from "../../src/ai/gemini";

const replies: unknown[] = [];
const requestGeminiResponseMock = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => {
  const response: GenerateContentResponse | undefined = replies.shift() as GenerateContentResponse | undefined;
  if (!response) return { ok: false, diagnostic: "request failed" };
  const finishReason: string | undefined = response.candidates?.[0]?.finishReason as string | undefined;
  if (finishReason !== undefined && finishReason !== "STOP") {
    return { ok: false, diagnostic: `finishReason=${finishReason}`, finishReason, response };
  }
  return { ok: true, response };
});
const callToolMock = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
const loggerErrorMock = mock((..._args: unknown[]): void => {});

mock.module("../../src/ai/gemini", () => ({ requestGeminiResult: requestGeminiResponseMock }));
mock.module("../../src/ai/mood", () => ({ currentMoodInstruction: (): string => "当前心情测试" }));
mock.module("../../src/ai/tools", () => ({ callTool: callToolMock }));
mock.module("../../src/infra/logger", () => ({ logger: { error: loggerErrorMock } }));
mock.module("../../src/workers/aiChat/timeSentence", () => ({ currentTimeSentence: (): string => "当前实际时间：测试。" }));

const { callGemini } = await import("../../src/workers/aiChat/geminiReply");

beforeEach(() => {
  replies.length = 0;
  requestGeminiResponseMock.mockClear();
  callToolMock.mockClear();
  loggerErrorMock.mockClear();
});

test("单轮请求同时注册 googleSearch 与函数工具，并强制先查证再行动", async () => {
  replies.push(
    {
      candidates: [{
        content: {
          role: "model",
          parts: [{ functionCall: { id: "call-1", name: "send_message", args: { text: "已核实回复" } } }],
        },
      }],
    },
    {
      candidates: [{ content: { role: "model", parts: [{ text: "行动完成" }] } }],
    }
  );

  const registeredTools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }];
  const execute = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
  const toolset: ReplyToolset = {
    definitions: [],
    tools: registeredTools,
    has: (name: string): boolean => name === "send_message",
    execute,
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBe("行动完成");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);

  const firstRequest = requestGeminiResponseMock.mock.calls[0]![0] as GenerateContentParameters;
  expect(firstRequest.config?.tools).toEqual(registeredTools);
  expect(firstRequest.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  expect(String(firstRequest.config?.systemInstruction)).toContain("googleSearch 已作为本轮可调用工具真实注册");
  expect(String(firstRequest.config?.systemInstruction)).toContain("累计最多调用 3 次");
  expect(String(firstRequest.config?.systemInstruction)).toContain("绝不能先行动再补查");
  expect((firstRequest.contents as unknown[])[0]).toEqual({ role: "user", parts: [{ text: "聊天上下文" }] });
  expect(execute).toHaveBeenCalledWith("send_message", JSON.stringify({ text: "已核实回复" }));
});

test("累计三次服务端搜索后，后续工具轮移除 googleSearch", async () => {
  replies.push(
    {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { toolCall: { id: "search-1", toolType: "GOOGLE_SEARCH_WEB" } },
            { toolResponse: { id: "search-1", toolType: "GOOGLE_SEARCH_WEB", response: {} } },
            { toolCall: { id: "search-2", toolType: "GOOGLE_SEARCH_WEB" } },
            { toolResponse: { id: "search-2", toolType: "GOOGLE_SEARCH_WEB", response: {} } },
            { toolCall: { id: "search-3", toolType: "GOOGLE_SEARCH_WEB" } },
            { toolResponse: { id: "search-3", toolType: "GOOGLE_SEARCH_WEB", response: {} } },
            { functionCall: { id: "call-1", name: "send_message", args: { text: "搜完了" } } },
          ],
        },
      }],
    },
    { candidates: [{ content: { role: "model", parts: [{ text: "行动完成" }] } }] }
  );

  const registeredTools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }];
  const execute = mock(async (): Promise<string> => JSON.stringify({ success: true }));
  const toolset: ReplyToolset = {
    definitions: [],
    tools: registeredTools,
    has: (name: string): boolean => name === "send_message",
    execute,
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBe("行动完成");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);
  const secondRequest = requestGeminiResponseMock.mock.calls[1]![0] as GenerateContentParameters;
  expect(secondRequest.config?.tools).toEqual([{ functionDeclarations: [{ name: "send_message" }] }]);
  expect(secondRequest.config?.toolConfig).toBeUndefined();
  expect(String(secondRequest.config?.systemInstruction)).toContain("已经达到 3 次 Google Search 上限");
});

test("服务端先报 TOO_MANY_TOOL_CALLS 时，零动作轮关闭搜索后只重试一次", async () => {
  replies.push(
    {
      candidates: [{
        finishReason: "TOO_MANY_TOOL_CALLS",
        content: { role: "model", parts: [] },
      }],
    },
    {
      candidates: [{
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: "不再搜索，直接回答" }] },
      }],
    }
  );

  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBe("不再搜索，直接回答");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);
  const retryRequest = requestGeminiResponseMock.mock.calls[1]![0] as GenerateContentParameters;
  expect(retryRequest.config?.tools).toEqual([{ functionDeclarations: [{ name: "send_message" }] }]);
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("retrying once with Google Search disabled"));
});

test("同一模型响应中的多个行动工具严格按返回顺序串行执行", async () => {
  replies.push(
    {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { functionCall: { id: "call-1", name: "generate_image", args: { prompt: "画一只猫" } } },
            { functionCall: { id: "call-2", name: "send_message", args: { text: "画好了" } } },
          ],
        },
      }],
    },
    { candidates: [{ content: { role: "model", parts: [] } }] }
  );

  const executionOrder: string[] = [];
  let releaseImage: (() => void) | undefined;
  const imagePending = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const execute = mock(async (name: string): Promise<string> => {
    executionOrder.push(`${name}:start`);
    if (name === "generate_image") await imagePending;
    executionOrder.push(`${name}:end`);
    return JSON.stringify({ success: true });
  });
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "generate_image" }, { name: "send_message" }] }],
    has: (name: string): boolean => name === "generate_image" || name === "send_message",
    execute,
    actionsUsed: (): number => 2,
    isActive: (): boolean => true,
  };

  const reply = callGemini(-1001, "聊天上下文", toolset);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(executionOrder).toEqual(["generate_image:start"]);

  releaseImage?.();
  await expect(reply).resolves.toBeNull();
  expect(executionOrder).toEqual([
    "generate_image:start",
    "generate_image:end",
    "send_message:start",
    "send_message:end",
  ]);
});

test("最终输出被 token 上限截断时返回 null", async () => {
  replies.push({
    candidates: [{
      finishReason: "MAX_TOKENS",
      content: { role: "model", parts: [{ text: "半截资料" }] },
    }],
  });
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});

test("请求在途时被禁用，响应回来后不再执行任何行动", async () => {
  let active: boolean = true;
  requestGeminiResponseMock.mockImplementationOnce(async (): Promise<GeminiRequestResult> => {
    active = false;
    return { ok: true, response: {
      candidates: [{ content: { role: "model", parts: [{ text: "迟到的搜索资料" }] } }],
    } as unknown as GenerateContentResponse };
  });
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => active,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});

test("连续无效参数也计入单工具预算，达到四次后从下一请求移除声明", async () => {
  for (let index = 0; index < 4; index++) {
    replies.push({
      candidates: [{ content: { role: "model", parts: [{ functionCall: { id: `bad-${index}`, name: "view_sticker_pack", args: {} } }] } }],
    });
  }
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "不再重试" }] } }] });
  const execute = mock(async (): Promise<string> => JSON.stringify({ error: "invalid arguments" }));
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ functionDeclarations: [{ name: "view_sticker_pack" }] }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "错拼角色名", toolset)).resolves.toBe("不再重试");
  expect(execute).toHaveBeenCalledTimes(4);
  const lastRequest = requestGeminiResponseMock.mock.calls[4]![0] as GenerateContentParameters;
  expect(lastRequest.config?.tools).toEqual([]);
});

test("同一响应多调用计入总预算，最多执行十六个并在下一请求移除全部函数", async () => {
  const names = Array.from({ length: 18 }, (_, index) => `tool_${index}`);
  replies.push({
    candidates: [{
      content: {
        role: "model",
        parts: names.map((name, index) => ({ functionCall: { id: `call-${index}`, name, args: {} } })),
      },
    }],
  });
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "预算收敛" }] } }] });
  const execute = mock(async (): Promise<string> => JSON.stringify({ error: "failed" }));
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ functionDeclarations: names.map((name) => ({ name })) }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "并行调用", toolset)).resolves.toBe("预算收敛");
  expect(execute).toHaveBeenCalledTimes(16);
  const secondRequest = requestGeminiResponseMock.mock.calls[1]![0] as GenerateContentParameters;
  expect(secondRequest.config?.tools).toEqual([]);
});

test("异常 candidate 夹带文本和 functionCall 时零执行、零最终文本", async () => {
  replies.push({
    candidates: [{
      finishReason: "PROHIBITED_CONTENT",
      finishMessage: "blocked",
      content: { role: "model", parts: [{ text: "半截文本" }, { functionCall: { name: "send_message", args: { text: "不得发送" } } }] },
    }],
  });
  const execute = mock(async (): Promise<string> => JSON.stringify({ success: true }));
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "上下文", toolset)).resolves.toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("finish_reason=PROHIBITED_CONTENT"));
});

test("已经产生外部副作用后遇到 TOO_MANY_TOOL_CALLS 不做降级重试", async () => {
  replies.push({ candidates: [{ finishReason: "TOO_MANY_TOOL_CALLS", content: { role: "model", parts: [] } }] });
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "上下文", toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});
