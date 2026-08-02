import { beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GenerateContentParameters, GenerateContentResponse, Tool } from "@google/genai";
import { AI_CHAT_AGENT_ROLE_INSTRUCTION } from "../../../packages/consts/aiChat/prompts/agent";
import {
  CHAT_INTERACTION_INSTRUCTION,
  MEMORY_MECHANISM_SILENCE_INSTRUCTION,
} from "../../../packages/consts/aiChat/prompts/memory";
import {
  GROUNDED_REPLY_TEMPERATURE,
  HARD_MAX_ACTIONS_PER_REPLY,
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_GOOGLE_SEARCH_CALLS_PER_REPLY,
  REPLY_TEMPERATURE,
} from "../../../packages/consts/aiChat/tools";
import { PERSONA_PATH } from "../../../packages/consts/paths";
import {
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  VIEW_STICKER_PACK_TOOL,
} from "../../../packages/consts/tools";
import type { ReplyPromptSections, ReplyToolset } from "../../../packages/types/aiChat/replies";
import type { GeminiRequestResult } from "../../../packages/types/aiChat/gemini";
import type { GeminiResponseFixture } from "../../helpers/geminiResponse";
import { geminiResponse } from "../../helpers/geminiResponse";

const replies: unknown[] = [];
const requestGeminiResponseMock = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => {
  const fixture: GeminiResponseFixture | undefined = replies.shift() as GeminiResponseFixture | undefined;
  if (!fixture) return { ok: false, failureKind: "request", diagnostic: "request failed" };
  const response: GenerateContentResponse = geminiResponse(fixture);
  const finishReason: string | undefined = response.candidates?.[0]?.finishReason as string | undefined;
  if (finishReason !== undefined && finishReason !== "STOP") {
    return { ok: false, failureKind: "response", diagnostic: `finishReason=${finishReason}`, finishReason, response };
  }
  return { ok: true, response };
});
const callToolMock = mock(async (..._args: unknown[]): Promise<string> => JSON.stringify({ success: true }));
const loggerErrorMock = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/ai/gemini", () => ({ requestGeminiResult: requestGeminiResponseMock }));
mock.module("../../../packages/aiChat/ai/mood", () => ({ currentMoodInstruction: (): string => "当前心情测试" }));
mock.module("../../../packages/aiChat/ai/tools", () => ({ callTool: callToolMock }));
mock.module("../../../packages/infra/logger", () => ({ logger: { error: loggerErrorMock } }));
mock.module("../../../packages/workers/aiChat/timeSentence", () => ({ currentTimeSentence: (): string => "当前实际时间：测试。" }));

const { callGemini } = await import("../../../packages/workers/aiChat/geminiReply");

function promptSections(label: string): ReplyPromptSections {
  return {
    referenceMemory: `${label}：参考记忆`,
    currentConversation: `${label}：当前会话`,
    invokerFocus: `${label}：唤起者重点记录`,
    replyTask: `${label}：回复任务`,
  };
}

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
    tools: registeredTools,
    has: (name: string): boolean => name === "send_message",
    execute,
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  const sections: ReplyPromptSections = promptSections("聊天上下文");
  await expect(callGemini(-1001, sections, toolset)).resolves.toBe("行动完成");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);

  const firstRequest = requestGeminiResponseMock.mock.calls[0]![0] as GenerateContentParameters;
  expect(firstRequest.config?.tools).toEqual(registeredTools);
  expect(firstRequest.config?.toolConfig).toEqual({ includeServerSideToolInvocations: true });
  expect(String(firstRequest.config?.systemInstruction)).toContain("googleSearch 已作为本轮可调用工具真实注册");
  expect(String(firstRequest.config?.systemInstruction)).toContain(`累计最多调用 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次`);
  expect(String(firstRequest.config?.systemInstruction)).toContain("绝不能先行动再补查");
  expect(String(firstRequest.config?.systemInstruction)).toContain("不计入本轮动作数");
  expect(firstRequest.config?.temperature).toBe(REPLY_TEMPERATURE);
  expect(String(firstRequest.config?.systemInstruction)).toContain("3～4 个顺序固定的 text Part");
  expect(String(firstRequest.config?.systemInstruction)).toContain("额外插入唯一一个 [BEGIN DIRECT_INVOKER_HOT_MESSAGES]");
  expect(String(firstRequest.config?.systemInstruction)).toContain("唤起者只认真正那个 Part 里的那一条");
  expect(String(firstRequest.config?.systemInstruction)).toContain("聊天记忆只分两层仲裁");
  expect(String(firstRequest.config?.systemInstruction)).toContain("唤起者发送记录的按 id 副本");
  expect(String(firstRequest.config?.systemInstruction)).toContain(MEMORY_MECHANISM_SILENCE_INSTRUCTION);
  expect(String(firstRequest.config?.systemInstruction)).toContain(AI_CHAT_AGENT_ROLE_INSTRUCTION);
  expect(String(firstRequest.config?.systemInstruction)).toContain(CHAT_INTERACTION_INSTRUCTION);
  expect(String(firstRequest.config?.systemInstruction)).toContain("叠加在基础人设上的今日状态");
  expect((firstRequest.contents as unknown[])[0]).toEqual({
    role: "user",
    parts: [
      { text: sections.referenceMemory },
      { text: sections.currentConversation },
      { text: sections.invokerFocus },
      { text: sections.replyTask },
    ],
  });
  expect((firstRequest.contents as { role?: string }[]).map((content) => content.role)).toEqual(["user", "model", "user"]);
  expect(execute).toHaveBeenCalledWith("send_message", JSON.stringify({ text: "已核实回复" }));
});

test("非直接触发不插入唤起者重点 Part", async () => {
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "随机插话" }] } }] });
  const toolset: ReplyToolset = {
    tools: [],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };
  const sections: ReplyPromptSections = {
    referenceMemory: "参考记忆",
    currentConversation: "当前会话",
    replyTask: "回复任务",
  };

  await expect(callGemini(-1001, sections, toolset)).resolves.toBe("随机插话");
  const request = requestGeminiResponseMock.mock.calls[0]![0] as GenerateContentParameters;
  expect((request.contents as unknown[])[0]).toEqual({
    role: "user",
    parts: [
      { text: sections.referenceMemory },
      { text: sections.currentConversation },
      { text: sections.replyTask },
    ],
  });
});

test("agent 身份权限边界与上下文协议由代码注入，不混入可编辑的人设文件", () => {
  expect(AI_CHAT_AGENT_ROLE_INSTRUCTION).toContain("只以普通群友身份参与闲聊");
  expect(AI_CHAT_AGENT_ROLE_INSTRUCTION).toContain("不具备直接调度、授予、撤销或修改任何权限的能力");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("[username:@用户名]");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("消息明确回复了你发出的某条消息");
  expect(CHAT_INTERACTION_INSTRUCTION).toContain("别把别人互相 at 错认成在叫你");
  const persona: string = readFileSync(PERSONA_PATH, "utf8");
  expect(persona).not.toContain("## Agent 身份与权限边界");
  expect(persona).not.toContain("## 上下文与互动规则");
});

/** 一轮里连续跑满 count 次服务端搜索的响应 parts，末尾附一次 send_message
 *  以驱动下一轮工具往返。 */
function searchRoundParts(count: number): unknown[] {
  const parts: unknown[] = [];
  for (let index: number = 1; index <= count; index++) {
    parts.push({ toolCall: { id: `search-${index}`, toolType: "GOOGLE_SEARCH_WEB" } });
    parts.push({ toolResponse: { id: `search-${index}`, toolType: "GOOGLE_SEARCH_WEB", response: {} } });
  }
  parts.push({ functionCall: { id: "call-1", name: "send_message", args: { text: "搜完了" } } });
  return parts;
}

test("搜索额度跑满后，后续工具轮移除 googleSearch", async () => {
  replies.push(
    {
      candidates: [{
        content: { role: "model", parts: searchRoundParts(MAX_GOOGLE_SEARCH_CALLS_PER_REPLY) },
      }],
    },
    { candidates: [{ content: { role: "model", parts: [{ text: "行动完成" }] } }] }
  );

  const registeredTools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }];
  const execute = mock(async (): Promise<string> => JSON.stringify({ success: true }));
  const toolset: ReplyToolset = {
    tools: registeredTools,
    has: (name: string): boolean => name === "send_message",
    execute,
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("聊天上下文"), toolset)).resolves.toBe("行动完成");
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(2);
  const secondRequest = requestGeminiResponseMock.mock.calls[1]![0] as GenerateContentParameters;
  expect(secondRequest.config?.tools).toEqual([{ functionDeclarations: [{ name: "send_message" }] }]);
  expect(secondRequest.config?.toolConfig).toBeUndefined();
  expect(String(secondRequest.config?.systemInstruction))
    .toContain(`已经达到 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY} 次 Google Search 上限`);
  // 额度耗尽也必须继续约束结果怎么用，并压低采样随机性。
  expect(String(secondRequest.config?.systemInstruction)).toContain("一律以搜索结果为准");
  expect(secondRequest.config?.temperature).toBe(GROUNDED_REPLY_TEMPERATURE);
});

test("搜过且仍有额度时，联网查证说明切到结果纪律并降温", async () => {
  replies.push(
    { candidates: [{ content: { role: "model", parts: searchRoundParts(1) } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "行动完成" }] } }] }
  );

  const registeredTools: Tool[] = [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }];
  const toolset: ReplyToolset = {
    tools: registeredTools,
    has: (name: string): boolean => name === "send_message",
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("聊天上下文"), toolset)).resolves.toBe("行动完成");
  const secondRequest = requestGeminiResponseMock.mock.calls[1]![0] as GenerateContentParameters;
  // 搜索工具仍在，但提示词重心从「该不该搜」换成「结果怎么用 + 缺口补搜」。
  expect(secondRequest.config?.tools).toEqual(registeredTools);
  expect(String(secondRequest.config?.systemInstruction)).toContain("本轮你已经调用过 googleSearch");
  expect(String(secondRequest.config?.systemInstruction)).toContain("一律以搜索结果为准");
  expect(String(secondRequest.config?.systemInstruction)).not.toContain("【动手前的强制自查】");
  expect(String(secondRequest.config?.systemInstruction))
    .toContain(`当前还可调用 ${MAX_GOOGLE_SEARCH_CALLS_PER_REPLY - 1} 次`);
  expect(secondRequest.config?.temperature).toBe(GROUNDED_REPLY_TEMPERATURE);
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
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("聊天上下文"), toolset)).resolves.toBe("不再搜索，直接回答");
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
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "generate_image" }, { name: "send_message" }] }],
    has: (name: string): boolean => name === "generate_image" || name === "send_message",
    execute,
    actionsUsed: (): number => 2,
    isActive: (): boolean => true,
  };

  const reply = callGemini(-1001, promptSections("聊天上下文"), toolset);
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
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("聊天上下文"), toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});

test("请求在途时被禁用，响应回来后不再执行任何行动", async () => {
  let active: boolean = true;
  requestGeminiResponseMock.mockImplementationOnce(async (): Promise<GeminiRequestResult> => {
    active = false;
    return { ok: true, response: geminiResponse({
      candidates: [{ content: { role: "model", parts: [{ text: "迟到的搜索资料" }] } }],
    }) };
  });
  const toolset: ReplyToolset = {
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 0,
    isActive: (): boolean => active,
  };

  await expect(callGemini(-1001, promptSections("聊天上下文"), toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});

test("不存在通用单工具四次上限，无效调用只受整轮总预算约束", async () => {
  for (let index = 0; index < 5; index++) {
    replies.push({
      candidates: [{
        content: {
          role: "model",
          parts: [{ functionCall: { id: `bad-${index}`, name: VIEW_STICKER_PACK_TOOL, args: {} } }],
        },
      }],
    });
  }
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "不再重试" }] } }] });
  const execute = mock(async (): Promise<string> => JSON.stringify({ error: "invalid arguments" }));
  const toolset: ReplyToolset = {
    tools: [{ functionDeclarations: [{ name: VIEW_STICKER_PACK_TOOL }] }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("错拼角色名"), toolset)).resolves.toBe("不再重试");
  expect(execute).toHaveBeenCalledTimes(5);
  const finalRequest = requestGeminiResponseMock.mock.calls[5]![0] as GenerateContentParameters;
  expect(finalRequest.config?.tools).toEqual([{ functionDeclarations: [{ name: VIEW_STICKER_PACK_TOOL }] }]);
});

test("四类可见动作共享十一动作硬顶，达到后一起移除但保留贴纸包查看", async () => {
  const actionSequence: string[] = [
    ...Array.from({ length: HARD_MAX_ACTIONS_PER_REPLY - 3 }, () => SEND_MESSAGE_TOOL),
    SEND_STICKER_TOOL,
    ADD_REACTION_TOOL,
    GENERATE_IMAGE_TOOL,
  ];
  for (const [index, name] of actionSequence.entries()) {
    replies.push({
      candidates: [{
        content: {
          role: "model",
          parts: [{ functionCall: { id: `action-${index}`, name, args: {} } }],
        },
      }],
    });
  }
  replies.push({ candidates: [{ content: { role: "model", parts: [{ text: "动作完成" }] } }] });
  let actionsUsed: number = 0;
  const execute = mock(async (): Promise<string> => {
    actionsUsed++;
    return JSON.stringify({ success: true });
  });
  const declarations = [
    { name: SEND_MESSAGE_TOOL },
    { name: SEND_STICKER_TOOL },
    { name: ADD_REACTION_TOOL },
    { name: GENERATE_IMAGE_TOOL },
    { name: VIEW_STICKER_PACK_TOOL },
  ];
  const toolset: ReplyToolset = {
    tools: [{ functionDeclarations: declarations }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => actionsUsed,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("混合动作"), toolset)).resolves.toBe("动作完成");

  expect(execute).toHaveBeenCalledTimes(HARD_MAX_ACTIONS_PER_REPLY);
  expect(actionsUsed).toBe(HARD_MAX_ACTIONS_PER_REPLY);
  const finalRequest = (
    requestGeminiResponseMock.mock.calls[HARD_MAX_ACTIONS_PER_REPLY]![0]
  ) as GenerateContentParameters;
  expect(finalRequest.config?.tools).toEqual([{
    functionDeclarations: [{ name: VIEW_STICKER_PACK_TOOL }],
  }]);
});

test("同一响应多调用计入总预算，达到硬顶后在下一请求移除全部函数", async () => {
  const names = Array.from({ length: MAX_CUSTOM_TOOL_CALLS_PER_REPLY + 2 }, (_, index) => `tool_${index}`);
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
    tools: [{ functionDeclarations: names.map((name) => ({ name })) }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("并行调用"), toolset)).resolves.toBe("预算收敛");
  expect(execute).toHaveBeenCalledTimes(MAX_CUSTOM_TOOL_CALLS_PER_REPLY);
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
    tools: [{ functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => true,
    execute,
    actionsUsed: (): number => 0,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("上下文"), toolset)).resolves.toBeNull();
  expect(execute).not.toHaveBeenCalled();
  expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("finish_reason=PROHIBITED_CONTENT"));
});

test("已经产生外部副作用后遇到 TOO_MANY_TOOL_CALLS 不做降级重试", async () => {
  replies.push({ candidates: [{ finishReason: "TOO_MANY_TOOL_CALLS", content: { role: "model", parts: [] } }] });
  const toolset: ReplyToolset = {
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "send_message" }] }],
    has: (): boolean => false,
    execute: async (): Promise<string> => JSON.stringify({ success: true }),
    actionsUsed: (): number => 1,
    isActive: (): boolean => true,
  };

  await expect(callGemini(-1001, promptSections("上下文"), toolset)).resolves.toBeNull();
  expect(requestGeminiResponseMock).toHaveBeenCalledTimes(1);
});
