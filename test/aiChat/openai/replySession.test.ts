/**
 * OpenAI 回复会话：中立请求到 Responses 请求体的映射，以及多轮工具往返的
 * input item 累积。
 *
 * 重点守三条：instructions 必须显式带上（缺了会被网关灌自己的提示词）、
 * 联网查证挂的是内建 hosted web_search 工具、function_call 与
 * function_call_output 必须靠 call_id 正确配对。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import type { OpenAiRequestResult } from "../../../packages/types/aiChat/openai";
import type { AiReplySession, AiToolDefinition } from "../../../packages/types/aiChat/provider";
import { getAiAgentOpenAiConfig } from "../../../packages/config/openai";

const requestOpenAiResult = mock(async (..._args: unknown[]): Promise<OpenAiRequestResult> => ({
  ok: false,
  failureKind: "request",
  diagnostic: "request failed",
}));

mock.module("../../../packages/aiChat/openai/client", () => ({ requestOpenAiResult }));

const { createOpenAiReplySession } = await import("../../../packages/aiChat/openai/replySession");
const {
  OPENAI_REPLY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} = await import("../../../packages/consts/aiChat/openai");

const SEND_MESSAGE: AiToolDefinition = {
  name: "send_message",
  description: "发一条群消息",
  parametersJsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

type ResponseBody = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** 取第 index 次调用交给底层的请求体构造器并就地求值：请求体改在 client.ts 的
 *  try 内构造，好让 config/openai.json 的解析错误降级成一次普通失败而不是抛出。 */
function capturedBody(index: number): ResponseBody {
  return (requestOpenAiResult.mock.calls[index]![0] as () => ResponseBody)();
}

/** 一份带 reasoning、web_search_call 与 function_call 的模型输出。 */
function modelOutput(): unknown[] {
  return [
    { type: "reasoning", id: "rs-1", summary: [] },
    { type: "web_search_call", id: "ws-1", status: "completed", action: { type: "search" } },
    { type: "function_call", id: "fc-1", call_id: "call-1", name: "send_message", arguments: '{"text":"你好"}', status: "completed" },
  ];
}

function okResult(output: unknown[], outputText: string = ""): OpenAiRequestResult {
  return {
    ok: true,
    response: {
      status: "completed",
      error: null,
      incomplete_details: null,
      output,
      output_text: outputText,
    },
  } as unknown as OpenAiRequestResult;
}

function baseRequest(overrides: Partial<Parameters<AiReplySession["request"]>[0]> = {}) {
  return {
    systemPrompt: "系统提示词",
    functions: [SEND_MESSAGE],
    webSearchEnabled: false,
    grounded: false,
    ...overrides,
  };
}

beforeEach(() => {
  requestOpenAiResult.mockClear();
});

describe("OpenAI 回复会话的请求映射", () => {
  test("初始上下文区块映射成同一个 user 轮次下的多段 input_text，并显式带 instructions", async () => {
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块一", "区块二", "区块三"] });
    await session.request(baseRequest());

    const body: ResponseBody = capturedBody(0);
    expect(body.model).toBe(getAiAgentOpenAiConfig().models.reply);
    expect(body.instructions).toBe("系统提示词");
    expect(body.input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: "区块一" },
        { type: "input_text", text: "区块二" },
        { type: "input_text", text: "区块三" },
      ],
    }]);
    expect(body.max_output_tokens).toBe(OPENAI_REPLY_MAX_TOKENS);
    // 不落服务端会话：Worker 崩溃重建后没有任何一方持有 response id。
    expect(body.store).toBe(OPENAI_STORE_RESPONSES);
    expect(body.store).toBe(false);
  });

  test("从不发送采样温度：GPT-5 系推理模型只接受默认值，传别的值会直接 400", async () => {
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    // grounded 是中立契约里的语义位；本包据此不做任何采样调整。
    await session.request(baseRequest({ grounded: true }));

    const body: ResponseBody = capturedBody(0);
    expect(body.temperature).toBeUndefined();
  });

  test("开检索时挂 OpenAI 内建的 hosted web_search 工具", async () => {
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    await session.request(baseRequest({ webSearchEnabled: true }));

    const body: ResponseBody = capturedBody(0);
    expect(body.tools).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: SEND_MESSAGE.name,
        description: SEND_MESSAGE.description,
        parameters: SEND_MESSAGE.parametersJsonSchema,
        // 本项目的 schema 不声明 additionalProperties:false，开严格模式会被拒。
        strict: false,
      },
    ]);
  });

  test("关检索时只剩函数工具", async () => {
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    await session.request(baseRequest({ webSearchEnabled: false }));

    const body: ResponseBody = capturedBody(0);
    expect(body.tools).toEqual([{
      type: "function",
      name: SEND_MESSAGE.name,
      description: SEND_MESSAGE.description,
      parameters: SEND_MESSAGE.parametersJsonSchema,
      strict: false,
    }]);
  });
});

describe("OpenAI 回复会话的产出解析", () => {
  test("抽出函数调用并按 web_search_call item 计数服务端检索", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult(modelOutput(), "正文"));

    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    const turn = await session.request(baseRequest({ webSearchEnabled: true }));

    expect(turn.ok).toBe(true);
    expect(turn.text).toBe("正文");
    expect(turn.webSearchCalls).toBe(1);
    expect(turn.functionCalls).toEqual([
      { id: "call-1", name: "send_message", argumentsJson: '{"text":"你好"}' },
    ]);
    // OpenAI 没有「服务端工具调用过多」的对等信号。
    expect(turn.toolCallLimitHit).toBe(false);
  });

  test("空 arguments 归一成空对象，调用方只需处理一种形状", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult([
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "get_tokyo_weather", arguments: "", status: "completed" },
    ]));

    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    const turn = await session.request(baseRequest());
    expect(turn.functionCalls[0]?.argumentsJson).toBe("{}");
  });

  test("缺 call_id 的函数调用被跳过：无法与结果配对", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult([
      { type: "function_call", id: "fc-1", call_id: "", name: "send_message", arguments: "{}", status: "completed" },
    ]));

    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    const turn = await session.request(baseRequest());
    expect(turn.functionCalls).toEqual([]);
  });
});

describe("OpenAI 回复会话的对话记录累积", () => {
  test("模型 output item 原样接回，函数结果按 call_id 配对附在其后", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult(modelOutput()));

    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    const turn = await session.request(baseRequest({ webSearchEnabled: true }));
    expect(session.appendToolOutputs([
      { call: turn.functionCalls[0]!, responseJson: JSON.stringify({ success: true }) },
    ])).toBe(true);

    await session.request(baseRequest({ webSearchEnabled: true }));
    const body: ResponseBody = capturedBody(1);
    const input = body.input as unknown[];
    // 初始 user 轮次 + 两条可回放的模型 output item + 一条函数结果。
    // reasoning 不在其中：请求钉死 store:false 且不声明
    // include:["reasoning.encrypted_content"]，回放的只是一个背后没有任何载荷的
    // 服务端 id，官方端点会 400 拒绝整个请求。
    expect(input).toHaveLength(4);
    expect(input.some((item: unknown): boolean => (item as { type?: string }).type === "reasoning")).toBe(false);
    expect((input[1] as { type: string }).type).toBe("web_search_call");
    expect((input[2] as { type: string }).type).toBe("function_call");
    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ success: true }),
    });
  });

  test("缺 call_id 的 function_call 不回灌 input：它配不上任何 function_call_output", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult([
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "send_message", arguments: "{}", status: "completed" },
      // 网关串扰/乱码轮次会给出这种没法配对的项；抽取那边已经跳过它，
      // 回灌这边也必须跳过，否则下一轮请求被整体 400 拒绝。
      { type: "function_call", id: "fc-2", call_id: "", name: "send_sticker", arguments: "{}", status: "completed" },
    ]));

    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    const turn = await session.request(baseRequest());
    expect(turn.functionCalls).toHaveLength(1);
    expect(session.appendToolOutputs([
      { call: turn.functionCalls[0]!, responseJson: "{}" },
    ])).toBe(true);

    await session.request(baseRequest());
    const input = capturedBody(1).input as unknown[];
    // 初始 user 轮次 + 唯一那条可配对的 function_call + 它的结果。
    expect(input).toHaveLength(3);
    expect((input[1] as { call_id: string }).call_id).toBe("call-1");
  });

  test("上一次请求没成功时交不出可续接的轮次", async () => {
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    await session.request(baseRequest());
    expect(session.appendToolOutputs([
      { call: { id: "call-1", name: "send_message", argumentsJson: "{}" }, responseJson: "{}" },
    ])).toBe(false);
  });

  test("函数结果缺 call_id 时拒绝续接，不发出会被服务端整体拒绝的请求", async () => {
    requestOpenAiResult.mockResolvedValueOnce(okResult(modelOutput()));
    const session: AiReplySession = createOpenAiReplySession({ promptBlocks: ["区块"] });
    await session.request(baseRequest());

    expect(session.appendToolOutputs([
      { call: { name: "send_message", argumentsJson: "{}" }, responseJson: "{}" },
    ])).toBe(false);
  });
});
