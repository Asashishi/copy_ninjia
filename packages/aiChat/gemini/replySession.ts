/**
 * Gemini 侧的一轮回复会话：把中立的 AiReplySession 契约落到 generateContent
 * 的 contents 累积上。
 *
 * 会话记录的关键在于「上一轮模型的整个 content 原样接回」——里面带着 thought
 * signature，缺了会丢思考上下文，多轮工具往返的质量会肉眼可见地掉。因此
 * request() 每次都把模型这一轮的 content 暂存下来，等 appendToolOutputs() 连同
 * functionResponse 一起写进 contents。
 *
 * googleSearch 是服务端工具，搜索在 Google 侧自动执行，结果直接体现在最终
 * 文本里，不会以 functionCall 形式抛回来；与函数工具混用时必须要求 SDK 把
 * 服务端工具调用记录接回 content（includeServerSideToolInvocations），否则
 * Gemini API 会拒绝该组合或丢失搜索上下文。
 */

import type { Content, FunctionCall, GenerateContentParameters, GenerateContentResponse, Part, Tool } from "@google/genai";
import {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_ERROR_LABEL,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { isPlainRecord } from "../../libs/runtimeConfig";
import { requestGeminiResult } from "./client";
import { countGoogleSearchCalls } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolOutput,
} from "../../types/aiChat/provider";

/** 无函数调用时共用的空数组：调用方只读，不必每轮新建一个空数组。 */
const EMPTY_FUNCTION_CALLS: readonly AiFunctionCall[] = [];

/**
 * 按本轮配置拼请求要挂的工具集合。
 *
 * 中立的 AiToolDefinition 直接当 FunctionDeclaration 用，不逐字段抄一遍：
 * 前者是 `{ name, description, parametersJsonSchema }`，而 `@google/genai` 的
 * FunctionDeclaration 声明的恰好就是这三个（其余字段全可选，
 * `parametersJsonSchema?: unknown`）。逐字段复制产出的是形状完全相同的另一个
 * 对象，什么新东西都没有——而这里每个工具轮跑一次，用满 MAX_TOOL_ROUNDS 的
 * 一次回复就是几百个一次性对象，且就在每群每消息的回复路径上（见 AGENTS.md
 * 「不得复制同构对象」）。SDK 只序列化不改写这些声明，按引用透传是安全的；
 * 外层数组仍要新建一个，因为 Tool.functionDeclarations 要求可变数组。
 */
function buildTools(request: AiReplyTurnRequest): Tool[] {
  const tools: Tool[] = [];
  if (request.webSearchEnabled) tools.push({ googleSearch: {} });
  if (request.functions.length > 0) {
    tools.push({ functionDeclarations: [...request.functions] });
  }
  return tools;
}

/**
 * 抽出带 name 的函数调用；入参统一序列化成 JSON 字符串交给领域侧解析。
 *
 * 零调用时交回共用的空数组：每个回复的最后一轮按构造必然是零 function call 的
 * turn（那正是 workers/aiChat/replyModel.ts 的循环退出条件），再加上每个纯文本
 * 中间轮——哨兵原本只接在 `!result.ok` 的冷分支上，真正有流量的成功路径反而
 * 每轮都新分配一个空数组。
 */
function extractFunctionCalls(data: GenerateContentResponse): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const call of data.functionCalls ?? []) {
    if (typeof call.name !== "string") continue;
    const typed: FunctionCall = call;
    calls.push({
      id: typed.id,
      name: call.name,
      argumentsJson: JSON.stringify(typed.args ?? {}),
    });
  }
  return calls.length === 0 ? EMPTY_FUNCTION_CALLS : calls;
}

/** 建立一轮 Gemini 回复会话。会话随本轮结束即弃，不跨轮复用。 */
export function createGeminiReplySession({ promptBlocks, signal }: AiReplySessionParams): AiReplySession {
  const contents: Content[] = [{
    role: "user",
    parts: promptBlocks.map((text: string): Part => ({ text })),
  }];
  // 上一次 request() 拿到的模型 content，等 appendToolOutputs() 接回 contents。
  let pendingModelContent: Content | undefined;

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelContent = undefined;
      const result: GeminiRequestResult = await requestGeminiResult(
        "text",
        (): GenerateContentParameters => ({
          model: getAgentDeploymentConfig().text.model,
          contents,
          config: {
            systemInstruction: request.systemPrompt,
            abortSignal: signal,
            tools: buildTools(request),
            toolConfig: request.webSearchEnabled ? { includeServerSideToolInvocations: true } : undefined,
            // 查证过的轮次压低采样随机性，让模型照搜索结果讲；上层只给
            // grounded 语义，取什么温度由本包决定。
            temperature: request.grounded ? GEMINI_GROUNDED_REPLY_TEMPERATURE : GEMINI_REPLY_TEMPERATURE,
            maxOutputTokens: GEMINI_REPLY_MAX_TOKENS,
          },
        }),
        GEMINI_REPLY_ERROR_LABEL
      );

      // 检索次数在失败分支也要统计：那一次请求已经把服务端调用花掉了，不核销
      // 预算等于让后续轮次继续白送额度。
      const response: GenerateContentResponse | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);
      // 成功与失败两条分支按同一顺序初始化同一组字段：这个对象会流进
      // 回复循环里同一批读取点，shape 分叉会把那些访问点变成多态的
      // （见 AGENTS.md 的「性能、内存与 Bun/JSC JIT」一节）。
      if (!result.ok) {
        return {
          ok: false,
          text: null,
          functionCalls: EMPTY_FUNCTION_CALLS,
          webSearchCalls,
          finishReason: result.finishReason,
          finishMessage: result.finishMessage,
          toolCallLimitHit: result.finishReason === "TOO_MANY_TOOL_CALLS",
        };
      }
      pendingModelContent = result.response.candidates?.[0]?.content;
      return {
        ok: true,
        text: result.response.text || null,
        functionCalls: extractFunctionCalls(result.response),
        webSearchCalls,
        finishReason: undefined,
        finishMessage: undefined,
        toolCallLimitHit: false,
      };
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      // 缺 content 说明这次响应没法续接（模型轮次都拿不到，接回去只会让下一轮
      // 看到一段错位的对话）；交给调用方按「本轮到此为止」收尾。
      if (!pendingModelContent) return false;
      contents.push(pendingModelContent);
      pendingModelContent = undefined;
      const responseParts: Part[] = [];
      for (const output of outputs) {
        // 工具实现返回的都是 JSON 字符串（见 packages/aiChat/ai/tools），
        // functionResponse.response 要求对象，解析回来直接挂上。
        const parsed: unknown = JSON.parse(output.responseJson);
        if (!isPlainRecord(parsed)) throw new Error(`Tool ${output.call.name} returned a non-object JSON value`);
        responseParts.push({ functionResponse: { id: output.call.id, name: output.call.name, response: parsed } });
      }
      contents.push({ role: "user", parts: responseParts });
      return true;
    },
  };
}
