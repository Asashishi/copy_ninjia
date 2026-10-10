import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
/**
 * Gemini 侧的一轮回复会话：把中立的 AiReplySession 契约落到 generateContent
 * 的 contents 累积上。
 *
 * 上一轮模型的整个 content（含 thought signature）原样接回：request() 每次都把模型这一轮的
 * content 暂存下来，等 appendToolOutputs() 连同 functionResponse 一起写进 contents。
 *
 * googleSearch 是服务端工具，搜索在 Google 侧自动执行，结果体现在最终文本里，不以
 * functionCall 形式抛回；与函数工具混用时经 includeServerSideToolInvocations
 * （GEMINI_SERVER_TOOL_CONFIG）要求 SDK 把服务端工具调用记录接回 content。
 *
 * 两套请求结构：每轮回复的第 1 次请求在本群没有触发时刻记录（本线程还没有成功的回复请求、记录
 * 已被清理），或距记录超过 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 时，引用
 * 全群共用的显式缓存（cachedContent，只装 systemInstruction + tools + toolConfig，scope 见
 * contextCache.ts），请求里只发全部 contents。距记录落在此时长内（含相等）时这一次改发完整
 * 请求。缓存暂不可用，或会话固定的 text 快照已被热重载替换时，也走完整请求。
 * 第 2 次起一律发送完整的 systemInstruction、tools、toolConfig 与 contents，不看间隔。
 * 完整请求由服务端隐式前缀缓存按公共前缀命中。两套结构的 token 序列逐字一致，contents 与模型
 * content（含思考签名）的处理完全相同，只有 config 在 cachedContent 与三项完整字段之间切换。
 * 稳定区块排在易变区块之前，工具往返只向 contents 尾部追加。
 *
 * 触发时刻是本群上一次成功的 generateContent 的发出时刻，取本线程单调时钟 performance.now()，
 * 按群各记一个（见 cache/workers/aiChat/geminiContextCache.ts）。请求成功后才写入，失败的请求
 * 不写；并行请求可能乱序完成，不晚于本群已记录值的发出时刻不覆盖。显式缓存被拒后的完整结构
 * 补发按补发时刻计。
 *
 * 会话创建时固定 text 能力的配置与客户端，整轮的每次请求都用它们；agent 配置热重载只影响
 * 之后新建的会话。第 1 次请求时 agent 配置已被热重载替换（text 快照不再是同一个对象）的，
 * 不引用共用显式缓存，直接发完整请求。
 */

import type {
  Content,
  FunctionCall,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
  Tool,
} from "@google/genai";
import {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_ERROR_LABEL,
  GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
  GEMINI_SERVER_TOOL_CONFIG,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { geminiReplyLastRequestAt } from "../../cache/workers/aiChat/geminiContextCache";
import { isPlainRecord } from "../../libs/record";
import { getGeminiClient, requestGeminiResult } from "./client";
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
import type { AgentCapabilityConfig } from "../../types/config";

/**
 * 按本轮配置拼请求要挂的工具集合：googleSearch 在前，函数声明合成一个 Tool。
 *
 * 中立的 AiToolDefinition（`{ name, description, parametersJsonSchema }`）与 SDK 的
 * FunctionDeclaration 同形，按引用透传；SDK 只序列化、不改写这些声明。functionDeclarations
 * 数组每次新建（Tool.functionDeclarations 为可变数组类型）。
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
 * 零调用时交回共用空数组 EMPTY_FUNCTION_CALLS，不重复分配。
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

/**
 * 本群触发时刻是否仍落在隐式缓存窗口内（now 与记录同取 performance.now()）。
 * 没有记录，或经过时长超过 GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS 时为 false。
 */
function implicitCacheStillWarm(chatId: number, now: number): boolean {
  const lastRequestAt: number | undefined = geminiReplyLastRequestAt.get(chatId);
  return lastRequestAt !== undefined && now - lastRequestAt <= GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS;
}

/**
 * 把一次成功请求的发出时刻 sentAt 记为本群触发时刻。并行请求可能乱序完成，
 * 不晚于本群已记录值的不覆盖。
 */
function noteGeminiReplyRequest(chatId: number, sentAt: number): void {
  const recordedAt: number | undefined = geminiReplyLastRequestAt.get(chatId);
  if (recordedAt !== undefined && sentAt <= recordedAt) return;
  geminiReplyLastRequestAt.set(chatId, sentAt);
}

/** 建立一轮 Gemini 回复会话。会话随本轮结束即弃，不跨轮复用。 */
export function createGeminiReplySession(
  { chatId, stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const textConfig: AgentCapabilityConfig = getAgentDeploymentConfig().text;
  const client: GoogleGenAI = getGeminiClient("text");
  /**
   * 本轮会话记录。稳定区块与易变区块分成两个 user 轮次、稳定的在前
   * （见 types/aiChat/provider.ts 的 AiReplySessionParams）。
   */
  const contents: Content[] = [
    { role: "user", parts: stableBlocks.map((text: string): Part => ({ text })) },
    { role: "user", parts: volatileBlocks.map((text: string): Part => ({ text })) },
  ];
  // 上一次 request() 拿到的模型 content，等 appendToolOutputs() 接回 contents。
  let pendingModelContent: Content | undefined;

  // 本轮回复还没发过请求。只有第 1 次请求可能引用显式缓存，还要看本群上一次触发间隔。
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
    // grounded 轮次取 GEMINI_GROUNDED_REPLY_TEMPERATURE，其余取 GEMINI_REPLY_TEMPERATURE；
    // 温度由本包决定，上层只给 grounded 语义。
    const temperature: number = request.grounded ? GEMINI_GROUNDED_REPLY_TEMPERATURE : GEMINI_REPLY_TEMPERATURE;
    const model: string = textConfig.model;
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
   * 发一次请求。sentAt 是发出时的 performance.now()，请求成功才记为本群触发时刻，失败不记。
   * 请求体由 buildRequestBody 在发送时求值，抛错由 requestGeminiResult 归一成失败结果。
   */
  async function send(
    buildRequestBody: () => GenerateContentParameters,
    sentAt: number
  ): Promise<GeminiRequestResult> {
    const result: GeminiRequestResult = await requestGeminiResult({
      capability: "text",
      buildBody: buildRequestBody,
      errorLabel: GEMINI_REPLY_ERROR_LABEL,
      client,
    });
    if (result.ok) noteGeminiReplyRequest(chatId, sentAt);
    return result;
  }

  /** 按完整结构发一次请求（不引用显式缓存）。 */
  function requestFull(request: AiReplyTurnRequest, tools: Tool[], sentAt: number): Promise<GeminiRequestResult> {
    return send((): GenerateContentParameters => buildBody(request, tools, null), sentAt);
  }

  /**
   * 本群隐式窗口未覆盖的第 1 次请求（没有记录或超过间隔）：先取共用显式缓存，取到就按显式结构发；
   * 端点以 4xx 拒绝（failureKind 为 misconfigured 或 rejected）时释放登记，再按完整结构补发一次，
   * 补发的发出时刻另取。取不到缓存或其它失败与完整请求的处理相同，不补发。会话固定的配置已被
   * 热重载替换时直接发完整请求。
   */
  async function requestFirst(request: AiReplyTurnRequest, tools: Tool[], sentAt: number): Promise<GeminiRequestResult> {
    if (getAgentDeploymentConfig().text !== textConfig) return requestFull(request, tools, sentAt);
    const acquired: { name: string | null } = { name: null };
    const result: GeminiRequestResult = await send((): GenerateContentParameters => {
      acquired.name = acquireGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, geminiContextCacheContent({
        model: textConfig.model,
        systemInstruction: request.systemPrompt,
        tools,
        toolConfig: request.webSearchEnabled ? GEMINI_SERVER_TOOL_CONFIG : undefined,
      }));
      return buildBody(request, tools, acquired.name);
    }, sentAt);
    const cachedContent: string | null = acquired.name;
    if (
      cachedContent === null ||
      result.ok ||
      (result.failureKind !== "misconfigured" && result.failureKind !== "rejected")
    ) {
      return result;
    }
    releaseGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, cachedContent);
    return requestFull(request, tools, performance.now());
  }

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelContent = undefined;
      const tools: Tool[] = buildTools(request);
      // now 既用于判定，也是这次请求的发出时刻；判定只看此前已成功请求留下的记录。
      const now: number = performance.now();
      const useExplicitCache: boolean = firstRequest && !implicitCacheStillWarm(chatId, now);
      firstRequest = false;
      const result: GeminiRequestResult = useExplicitCache
        ? await requestFirst(request, tools, now)
        : await requestFull(request, tools, now);

      // 失败分支同样累计检索次数。
      const response: GenerateContentResponse | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);

      // 成功与失败两条分支按同一顺序初始化同一组字段，保持对象 shape 一致
      // （见 AGENTS.md 的「性能、内存与 Bun/JSC JIT」一节）。
      if (!result.ok) {
        return {
          ok: false,
          text: null,
          functionCalls: EMPTY_FUNCTION_CALLS,
          webSearchCalls,
          finishReason: result.finishReason,
          finishDetails: result.finishDetails,
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
        finishDetails: undefined,
        toolCallLimitHit: false,
      };
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      // 缺 content 时无法续接，返回 false，由调用方按「本轮到此为止」收尾。
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
