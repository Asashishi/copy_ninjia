/**
 * OpenAI 侧的一轮回复会话：把中立的 AiReplySession 契约落到 Responses API 的
 * input item 累积上。
 *
 * 请求固定 store=false（见 consts/aiChat/openai.ts 的 OPENAI_STORE_RESPONSES），
 * 因此多轮工具往返不靠服务端会话续接，而是把模型每一轮的 output item 原样
 * 追加回本地 input 列表，再挂上 function_call_output。`call_id` 是这两者之间
 * 唯一的关联键，缺了就没法续接。
 *
 * 联网查证走 OpenAI 内建的 hosted `web_search` 工具：检索在服务端自动执行，
 * 结果直接体现在最终正文里，只以 `web_search_call` item 的形式留下调用记录，
 * 不会以函数调用的形式抛回来——与 Gemini 的 googleSearch 是同一种服务端工具
 * 语义，因此上层的检索预算逻辑对两家通用。
 *
 * 已知与 Gemini 侧的第二处差异：请求不带采样温度，GPT-5 系推理模型只接受默认
 * 值。中立契约的 `grounded` 因此在本包不影响采样，只有 Gemini 侧会据此降温。
 *
 * 已知与 Gemini 侧的差异：本会话拿不到可回传的思考上下文。Responses 的
 * `reasoning.encrypted_content` 需要服务端配合返回，自建/代理网关普遍会把
 * reasoning item 剥掉，因此这里不声明 include，也不依赖跨轮思考续传——多轮
 * 工具往返只保证「函数调用与结果配对正确」，不保证思考连续。既然拿不到载荷，
 * 回放 reasoning item 也就一定是错的：见下方 toInputItems。
 */

import type OpenAI from "openai";
import {
  OPENAI_REPLY_ERROR_LABEL,
  OPENAI_REPLY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { getAiAgentOpenAiConfig } from "../../config/openai";
import { requestOpenAiResult } from "./client";
import {
  EMPTY_FUNCTION_CALLS,
  countWebSearchCalls,
  extractFunctionCalls,
  isPairableFunctionCall,
  responseOutputItems,
  responseOutputText,
} from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type {
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";

/** 中立工具声明转 Responses 的 function tool。两边的参数都是 JSON Schema，
 *  直接透传；strict 必须为 false——本项目的 schema 不声明
 *  additionalProperties:false，开严格模式会被服务端拒绝。 */
function toFunctionTool(definition: AiToolDefinition): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    // 按引用透传，不克隆：schema 是 consts 里构造后只读的对象，SDK 只序列化不
    // 改写它。每轮请求都克隆一遍等于每次工具往返白产生一批短命对象。
    parameters: definition.parametersJsonSchema,
    strict: false,
  };
}

/** 按本轮配置拼请求要挂的工具集合。 */
function buildTools(request: AiReplyTurnRequest): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = [];
  if (request.webSearchEnabled) tools.push({ type: "web_search" });
  for (const definition of request.functions) tools.push(toFunctionTool(definition));
  return tools;
}

/**
 * 把模型这一轮的 output item 收窄成可回填 input 的条目。只保留续接对话真正
 * 需要的三类：可配对的函数调用、正文消息、服务端检索记录；其余 item 类型本
 * 项目不挂载对应工具，出现即忽略。
 *
 * **函数调用要过 isPairableFunctionCall**，与 extractFunctionCalls 同一判据：
 * 缺 call_id 的那条不会被执行、也就配不上 function_call_output，原样推回
 * input 只会让下一轮请求被整体 400 拒绝（详见该函数的 JSDoc）。
 *
 * **reasoning item 一律不回放**：请求钉死 `store: false`
 * （OPENAI_STORE_RESPONSES），而这里也从不声明
 * `include: ["reasoning.encrypted_content"]`，因此回放的只是一个背后既没有
 * 服务端存储、也没有加密载荷的 `rs_…` id，官方 Responses 端点会 400 拒绝整个
 * 请求——于是**每一个需要多于一轮工具的回复**都会在第一轮副作用已经落地之后
 * 失败。日后真要回传思考上下文，必须连同 store 或 include 一起改，不能只把
 * 这一类加回来。
 */
function toInputItems(output: readonly OpenAI.Responses.ResponseOutputItem[]): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const item of output) {
    if (item.type === "function_call") {
      if (isPairableFunctionCall(item)) items.push(item);
    } else if (item.type === "message" || item.type === "web_search_call") {
      items.push(item);
    }
  }
  return items;
}

/** 建立一轮 OpenAI 回复会话。会话随本轮结束即弃，不跨轮复用。 */
export function createOpenAiReplySession({ promptBlocks, signal }: AiReplySessionParams): AiReplySession {
  const input: OpenAI.Responses.ResponseInputItem[] = [{
    role: "user",
    content: promptBlocks.map((text: string): OpenAI.Responses.ResponseInputContent => ({ type: "input_text", text })),
  }];
  // 上一次 request() 拿到的模型 output item，等 appendToolOutputs() 接回 input。
  let pendingModelItems: OpenAI.Responses.ResponseInputItem[] | undefined;

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelItems = undefined;
      // 请求体在 requestOpenAiResult 的 try 内构造：模型名来自 config/openai.json，
      // 那份文件写坏时解析会抛，构造留在这里就等于让异常绕过整条 ok:false 通路
      // （见 client.ts 的 requestOpenAiResult 与 config/readiness.ts 的闸门）。
      const result: OpenAiRequestResult = await requestOpenAiResult(
        (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
          model: getAiAgentOpenAiConfig().models.reply,
          instructions: request.systemPrompt,
          input,
          tools: buildTools(request),
          // 不带 temperature：GPT-5 系推理模型只接受默认值，传别的会直接
          // 400，因此 request.grounded 在本包不影响采样（见本文件头注）。
          max_output_tokens: OPENAI_REPLY_MAX_TOKENS,
          store: OPENAI_STORE_RESPONSES,
        }),
        OPENAI_REPLY_ERROR_LABEL,
        signal
      );

      // 检索次数在失败分支也要统计：那一次请求已经把服务端调用花掉了，不核销
      // 预算等于让后续轮次继续白送额度。
      const response: OpenAI.Responses.Response | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countWebSearchCalls(response);
      // 成功与失败两条分支按同一顺序初始化同一组字段，理由同
      // aiChat/gemini/replySession.ts 的同名分支。
      if (!result.ok) {
        return {
          ok: false,
          text: null,
          functionCalls: EMPTY_FUNCTION_CALLS,
          webSearchCalls,
          finishReason: result.finishReason,
          // Responses 没有与 Gemini finishMessage 对等的补充说明字段。
          finishMessage: undefined,
          // OpenAI 也没有「服务端工具调用过多」的对等信号；恒为 false 的
          // fail-safe 含义是「不触发关掉检索的那次额外重试」。
          toolCallLimitHit: false,
        };
      }
      // 过 responseOutputItems 而不是直接读 result.response.output：省略该字段的
      // 兼容网关会让它是 undefined，for...of 当场抛 TypeError（见 response.ts）。
      pendingModelItems = toInputItems(responseOutputItems(result.response));
      return {
        ok: true,
        text: responseOutputText(result.response) || null,
        functionCalls: extractFunctionCalls(result.response),
        webSearchCalls,
        finishReason: undefined,
        finishMessage: undefined,
        toolCallLimitHit: false,
      };
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      // 没有可续接的模型轮次说明上一次请求就没成功；交给调用方按「本轮到此
      // 为止」收尾，别把一段错位的对话喂进下一轮。
      if (!pendingModelItems) return false;
      const results: OpenAI.Responses.ResponseInputItem[] = [];
      for (const output of outputs) {
        // call_id 由 extractFunctionCalls 保证非空；缺了就无法与上一轮的
        // function_call 配对，服务端会直接拒绝整个请求。
        if (output.call.id === undefined) return false;
        results.push({
          type: "function_call_output",
          call_id: output.call.id,
          output: output.responseJson,
        });
      }
      input.push(...pendingModelItems, ...results);
      pendingModelItems = undefined;
      return true;
    },
  };
}
