/**
 * OpenAI 侧的一轮回复会话：把中立的 AiReplySession 契约落到 Responses API 的
 * input item 累积上。
 *
 * 请求固定 store=false（见 consts/aiChat/openai.ts 的 OPENAI_STORE_RESPONSES），
 * 多轮工具往返不靠服务端会话续接，而是把模型每一轮的 output item 原样
 * 追加回本地 input 列表，再挂上 function_call_output；`call_id` 是这两者之间
 * 的关联键。
 *
 * 联网查证走 OpenAI 内建的 hosted `web_search` 工具：检索在服务端自动执行，
 * 结果体现在最终正文里，只以 `web_search_call` item 的形式留下调用记录，
 * 不以函数调用的形式抛回；上层的检索预算逻辑对各家通用。
 *
 * 请求不带采样温度；中立契约的 `grounded` 在本包不影响采样。
 *
 * `store:false` 时，多轮工具往返把带非空 `reasoning.encrypted_content` 的 reasoning item
 * 与函数调用一起续传；id-only 的 reasoning item 丢弃。
 *
 * 会话创建时固定 text 能力的配置与客户端，整轮的每次请求都用它们；agent 配置热重载只影响
 * 之后新建的会话。
 */

import type OpenAI from "openai";
import {
  OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX,
  OPENAI_PROMPT_CACHE_KEY_PREFIX,
  OPENAI_PROMPT_CACHE_TTL,
  OPENAI_REPLY_ERROR_LABEL,
  OPENAI_REPLY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { getOpenAiClient, requestOpenAiResult } from "./client";
import { stablePrefixFingerprint } from "../../libs/prefixFingerprint";
import {
  countWebSearchCalls,
  extractFunctionCalls,
  isPairableFunctionCall,
  responseOutputItems,
  responseOutputText,
} from "./response";
import { failedReplyTurn } from "../ai/utils/replyTurn";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type {
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";
import type { AgentCapabilityConfig } from "../../types/config";

/** 中立工具声明转 Responses 的 function tool。两边的参数都是 JSON Schema，
 *  直接透传；strict 固定为 false。 */
function toFunctionTool(definition: AiToolDefinition): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    // 按引用透传，不克隆：schema 是 consts 里构造后只读的对象，SDK 只序列化不改写它。
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
 * 判断本次请求是否带 prompt cache breakpoint：provider 为 openai、未配置自定义 base_url
 * （SDK 默认端点），且模型名为 OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX 或以其加 `-` 开头时为真；
 * 其余请求不带 breakpoint 与 `prompt_cache_options`。
 */
function supportsPromptCacheBreakpoints(config: AgentCapabilityConfig): boolean {
  if (config.provider !== "openai" || config.baseUrl !== undefined) return false;
  return config.model === OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX ||
    config.model.startsWith(OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX + "-");
}

/**
 * 把模型这一轮的 output item 收窄成可回填 input 的条目。保留可回放的
 * 加密推理、可配对的函数调用、正文消息与服务端检索记录；其余 item 类型本
 * 项目不挂载对应工具，出现即忽略。
 *
 * 函数调用经 isPairableFunctionCall 过滤，与 extractFunctionCalls 同一判据。
 *
 * reasoning item 只在带非空 `encrypted_content` 时回放，其余丢弃。
 */
function toInputItems(output: readonly OpenAI.Responses.ResponseOutputItem[]): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const item of output) {
    if (
      item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0
    ) {
      items.push(item);
    } else if (item.type === "function_call") {
      if (isPairableFunctionCall(item)) items.push(item);
    } else if (item.type === "message" || item.type === "web_search_call") {
      items.push(item);
    }
  }
  return items;
}

/**
 * 建立一轮 OpenAI 回复会话。会话随本轮结束即弃，不跨轮复用。
 *
 * 稳定区块与易变区块按顺序拼进同一个 user 轮次，各自保持独立的 input_text 块，稳定的在前。
 * 所有请求都带按稳定前缀算出的 `prompt_cache_key`（分段哈希约定见 libs/prefixFingerprint.ts）。
 * supportsPromptCacheBreakpoints 为真时，最后一个稳定区块带显式 breakpoint，并以 implicit
 * 模式发送 `prompt_cache_options`；其余请求不发送这两个字段。
 */
export function createOpenAiReplySession(
  { stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const config: AgentCapabilityConfig = getAgentDeploymentConfig().text;
  const client: OpenAI = getOpenAiClient("text");
  const useBreakpoints: boolean = stableBlocks.length > 0 && supportsPromptCacheBreakpoints(config);
  const content: OpenAI.Responses.ResponseInputContent[] = [];
  for (let index: number = 0; index < stableBlocks.length; index += 1) {
    const text: string | undefined = stableBlocks[index];
    if (text === undefined) continue;
    if (index === stableBlocks.length - 1) {
      content.push({
        type: "input_text",
        text,
        prompt_cache_breakpoint: useBreakpoints ? { mode: "explicit" } : undefined,
      });
    } else {
      content.push({ type: "input_text", text });
    }
  }
  for (const text of volatileBlocks) content.push({ type: "input_text", text });
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content }];
  // 上一次 request() 拿到的模型 output item，等 appendToolOutputs() 接回 input。
  let pendingModelItems: OpenAI.Responses.ResponseInputItem[] | undefined;

  // prompt_cache_key 按工具形态记忆化：functions、systemPrompt 与 webSearchEnabled 都没变时
  // 复用上一次算好的键（webSearchEnabled 只会在供应商报服务端工具调用超限后的降级重试里变化，
  // 见 workers/aiChat/replyModel.ts 头注）。指纹覆盖完整稳定段，包括参考记忆。
  let cacheKey: string | undefined;
  let keyedFunctions: readonly AiToolDefinition[] | undefined;
  let keyedWebSearchEnabled: boolean | undefined;
  let keyedSystemPrompt: string | undefined;

  /**
   * 取本轮请求的 prompt_cache_key，工具形态没变就复用上一次算好的。
   *
   * 指纹覆盖 systemPrompt、工具声明与全部稳定区块（含按群变化的参考记忆），因此键按群区分。
   */
  function promptCacheKeyFor(request: AiReplyTurnRequest, tools: readonly OpenAI.Responses.Tool[]): string {
    if (
      cacheKey !== undefined &&
      keyedFunctions === request.functions &&
      keyedWebSearchEnabled === request.webSearchEnabled &&
      keyedSystemPrompt === request.systemPrompt
    ) {
      return cacheKey;
    }
    const fingerprint: string = stablePrefixFingerprint([
      request.systemPrompt,
      JSON.stringify(tools),
      ...stableBlocks,
    ]);
    cacheKey = OPENAI_PROMPT_CACHE_KEY_PREFIX + ":" + fingerprint;
    keyedFunctions = request.functions;
    keyedWebSearchEnabled = request.webSearchEnabled;
    keyedSystemPrompt = request.systemPrompt;
    return cacheKey;
  }

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelItems = undefined;
      // 请求体在 requestOpenAiResult 的 try 内构造（见 client.ts 的 requestOpenAiResult）。
      const tools: OpenAI.Responses.Tool[] = buildTools(request);
      const promptCacheKey: string = promptCacheKeyFor(request, tools);
      const result: OpenAiRequestResult = await requestOpenAiResult({
        capability: "text",
        buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
          model: config.model,
          instructions: request.systemPrompt,
          input,
          tools,
          // 只影响请求路由（见 consts/aiChat/openai.ts）。
          prompt_cache_key: promptCacheKey,
          // implicit 保留最新 user/tool 消息的自动断点；显式断点位于最后一个稳定区块末尾。
          prompt_cache_options: useBreakpoints
            ? { mode: "implicit", ttl: OPENAI_PROMPT_CACHE_TTL }
            : undefined,
          // 不带 temperature，request.grounded 在本包不影响采样（见本文件头注）。
          max_output_tokens: OPENAI_REPLY_MAX_TOKENS,
          store: OPENAI_STORE_RESPONSES,
        }),
        errorLabel: OPENAI_REPLY_ERROR_LABEL,
        signal,
        client,
      });

      // 失败分支同样累计检索次数。
      const response: OpenAI.Responses.Response | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countWebSearchCalls(response);

      // Responses 没有 finishMessage 与「服务端工具调用过多」的对等信号，失败轮走共用构造；
      // 成功分支按同一顺序初始化同一组字段。
      if (!result.ok) return failedReplyTurn(webSearchCalls, result.finishReason);
      // 经 responseOutputItems 读取 output，缺失时按空列表处理（见 response.ts）。
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
      // 没有可续接的模型轮次时返回 false，由调用方按「本轮到此为止」收尾。
      if (!pendingModelItems) return false;
      const results: OpenAI.Responses.ResponseInputItem[] = [];
      for (const output of outputs) {
        // call_id 由 extractFunctionCalls 保证非空；缺失时返回 false。
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
