import { beforeEach, expect, mock, test } from "bun:test";
import type { GenerateContentParameters, GenerateContentResponse, Tool } from "@google/genai";
import type { ReplyToolset } from "../../src/types";

const replies: unknown[] = [];
const requestGeminiResponseMock = mock(async (..._args: unknown[]): Promise<GenerateContentResponse | null> =>
  (replies.shift() as GenerateContentResponse | undefined) ?? null
);
const callToolMock = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));

mock.module("../../src/ai/gemini", () => ({ requestGeminiResponse: requestGeminiResponseMock }));
mock.module("../../src/ai/mood", () => ({ currentMoodInstruction: (): string => "当前心情测试" }));
mock.module("../../src/ai/tools", () => ({ callTool: callToolMock }));
mock.module("../../src/workers/aiChat/timeSentence", () => ({ currentTimeSentence: (): string => "当前实际时间：测试。" }));

const { callGemini } = await import("../../src/workers/aiChat/geminiReply");

beforeEach(() => {
  replies.length = 0;
  requestGeminiResponseMock.mockClear();
  callToolMock.mockClear();
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
    messagesSent: (): number => 1,
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBe("行动完成");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);

  const firstRequest = requestGeminiResponseMock.mock.calls[0]![0] as GenerateContentParameters;
  expect(firstRequest.config?.tools).toBe(registeredTools);
  expect(firstRequest.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  expect(String(firstRequest.config?.systemInstruction)).toContain("googleSearch 已作为本轮可调用工具真实注册");
  expect(String(firstRequest.config?.systemInstruction)).toContain("绝不能先行动再补查");
  expect((firstRequest.contents as unknown[])[0]).toEqual({ role: "user", parts: [{ text: "聊天上下文" }] });
  expect(execute).toHaveBeenCalledWith("send_message", JSON.stringify({ text: "已核实回复" }));
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
    messagesSent: (): number => 1,
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
    messagesSent: (): number => 0,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});

test("请求在途时被禁用，响应回来后不再执行任何行动", async () => {
  let active: boolean = true;
  requestGeminiResponseMock.mockImplementationOnce(async (): Promise<GenerateContentResponse> => {
    active = false;
    return {
      candidates: [{ content: { role: "model", parts: [{ text: "迟到的搜索资料" }] } }],
    } as unknown as GenerateContentResponse;
  });
  const toolset: ReplyToolset = {
    definitions: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    messagesSent: (): number => 0,
    actionsUsed: (): number => 0,
    isActive: (): boolean => active,
  };

  await expect(callGemini(-1001, "聊天上下文", toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});
