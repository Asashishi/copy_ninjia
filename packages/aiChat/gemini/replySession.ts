import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
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
 *
 * **两套请求结构**：每轮回复的第 1 次请求引用全群共用的显式缓存（cachedContent，只装
 * systemInstruction + tools + toolConfig，scope 见 contextCache.ts），请求里只发全部 contents；
 * 缓存暂不可用时这一次也走完整请求。第 2 次起一律发送完整的 systemInstruction、tools、
 * toolConfig 与 contents，由 Gemini 的隐式缓存按公共前缀接住第 1 次留下的块与工具往返。
 * 两套结构的 token 序列逐字一致，contents 与模型 content（含思考签名）的处理完全相同，
 * 只有 config 在 cachedContent 与三项完整字段之间切换。稳定区块排在易变区块之前，工具
 * 往返只向 contents 尾部追加。
 */

import type {
  Content,
  FunctionCall,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
  Tool,
} from "@google/genai";
import {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_ERROR_LABEL,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
  GEMINI_SERVER_TOOL_CONFIG,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { isPlainRecord } from "../../libs/record";
import { requestGeminiResult } from "./client";
import {
  acquireGeminiContextCache,
  geminiContextCacheContent,
  releaseGeminiContextCache,
} from "../../infra/geminiContextCache";
import { TEXT_GEMINI_CONTEXT_CACHE_SCOPE } from "./contextCache";
import { countGoogleSearchCalls, responseText } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolOutput,
} from "../../types/aiChat/provider";

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
 * 零调用时交回共用空数组：每个回复的最后一轮以及纯文本中间轮都没有 function
 * call，成功路径不为这些轮次重复分配空数组。
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
export function createGeminiReplySession(
  { stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  /**
   * 本轮会话记录。稳定区块与易变区块分成两个 user 轮次、稳定的在前：这是
   * Gemini 与 OpenAI 自动前缀缓存共同的命中前提（见 types/aiChat/provider.ts 的
   * AiReplySessionParams），也让参考记忆在两次压缩之间保持公共前缀。
   */
  const contents: Content[] = [
    { role: "user", parts: stableBlocks.map((text: string): Part => ({ text })) },
    { role: "user", parts: volatileBlocks.map((text: string): Part => ({ text })) },
  ];
  // 上一次 request() 拿到的模型 content，等 appendToolOutputs() 接回 contents。
  let pendingModelContent: Content | undefined;

  // 本轮回复还没发过请求：只有第 1 次请求尝试引用共用显式缓存。
  let firstRequest: boolean = true;

  /**
   * 拼一次请求体。cachedContent 非空时走显式缓存结构（systemInstruction、tools 与
   * toolConfig 都在缓存里，请求不得再带）；为空时走完整结构，由隐式缓存按公共前缀命中。
   */
  function buildBody(
    request: AiReplyTurnRequest,
    tools: Tool[],
    cachedContent: string | null
  ): GenerateContentParameters {
    // 查证过的轮次压低采样随机性，让模型照搜索结果讲；上层只给 grounded 语义，
    // 取什么温度由本包决定。
    const temperature: number = request.grounded ? GEMINI_GROUNDED_REPLY_TEMPERATURE : GEMINI_REPLY_TEMPERATURE;
    const model: string = getAgentDeploymentConfig().text.model;
    if (cachedContent !== null) {
      return {
        model,
        contents,
        config: { abortSignal: signal, cachedContent, temperature, maxOutputTokens: GEMINI_REPLY_MAX_TOKENS },
      };
    }
    return {
      model,
      contents,
      config: {
        abortSignal: signal,
        temperature,
        maxOutputTokens: GEMINI_REPLY_MAX_TOKENS,
        systemInstruction: request.systemPrompt,
        tools,
        toolConfig: request.webSearchEnabled ? GEMINI_SERVER_TOOL_CONFIG : undefined,
      },
    };
  }

  /**
   * 第 1 次请求：先取共用显式缓存，取到就按显式结构发；端点以 404/4xx 拒绝这份缓存
   * （已过期、被删或无权访问）时释放登记，再按完整结构补发一次。取不到或端点故障时
   * 与完整请求的处理相同，不补发。模型名在请求体闭包里读，配置写坏时由
   * requestGeminiResult 统一归一成失败结果。
   */
  async function requestFirst(request: AiReplyTurnRequest, tools: Tool[]): Promise<GeminiRequestResult> {
    const acquired: { name: string | null } = { name: null };
    const result: GeminiRequestResult = await requestGeminiResult(
      "text",
      (): GenerateContentParameters => {
        acquired.name = acquireGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, geminiContextCacheContent({
          model: getAgentDeploymentConfig().text.model,
          systemInstruction: request.systemPrompt,
          tools,
          toolConfig: request.webSearchEnabled ? GEMINI_SERVER_TOOL_CONFIG : undefined,
        }));
        return buildBody(request, tools, acquired.name);
      },
      GEMINI_REPLY_ERROR_LABEL
    );
    const cachedContent: string | null = acquired.name;
    if (
      cachedContent === null ||
      result.ok ||
      (result.failureKind !== "misconfigured" && result.failureKind !== "rejected")
    ) {
      return result;
    }
    releaseGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, cachedContent);
    return requestGeminiResult(
      "text",
      (): GenerateContentParameters => buildBody(request, tools, null),
      GEMINI_REPLY_ERROR_LABEL
    );
  }

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelContent = undefined;
      const tools: Tool[] = buildTools(request);
      const first: boolean = firstRequest;
      firstRequest = false;
      const result: GeminiRequestResult = first
        ? await requestFirst(request, tools)
        : await requestGeminiResult(
          "text",
          (): GenerateContentParameters => buildBody(request, tools, null),
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
        text: responseText(result.response) || null,
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
