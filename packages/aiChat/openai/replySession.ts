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
 * OpenAI 原生 Responses 在 `store:false` 时默认把可回放的
 * `reasoning.encrypted_content` 带回；多轮工具往返必须与函数调用一起续传。
 * 兼容网关可能剥掉该载荷，因此只回放确实带非空密文的 reasoning item；
 * id-only item 仍丢弃，避免下一轮被无服务端状态可查的兼容端点拒绝。
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
import { requestOpenAiResult } from "./client";
import { stablePrefixFingerprint } from "./promptCacheKey";
import {
  countWebSearchCalls,
  extractFunctionCalls,
  isPairableFunctionCall,
  responseOutputItems,
  responseOutputText,
} from "./response";
import { OPENAI_EMPTY_FUNCTION_CALLS as EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/openai";
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
 * 判断本次请求能否使用 GPT-5.6 的 prompt cache breakpoint 协议。
 *
 * 只有 SDK 默认的 OpenAI 官方端点且模型属于当前已核对的 GPT-5.6 家族时启用。
 * 自定义 base_url 代表兼容协议，不能因模型名相同就假定端点接受新字段；更早的
 * OpenAI 模型同样保留原来的自动前缀缓存请求形态。
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
 * **函数调用要过 isPairableFunctionCall**，与 extractFunctionCalls 同一判据：
 * 缺 call_id 的那条不会被执行、也就配不上 function_call_output，原样推回
 * input 只会让下一轮请求被整体 400 拒绝（详见该函数的 JSDoc）。
 *
 * **reasoning item 只在有非空加密载荷时回放**：OpenAI 原生端点在无状态
 * 模式下默认返回它，不需要额外的 include；兼容网关若只留下 `rs_…` id，
 * 回放反而可能因无服务端状态可查而被拒绝，所以仍然 fail-safe 丢弃。
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
 * 稳定区块与易变区块按顺序拼进同一个 user 轮次，**不合并成一段文本**：
 * Responses 的自动前缀缓存按 instructions → tools → input 的序列比对前缀，稳定
 * 内容排在前面才可能命中。所有模型都带按稳定前缀算出的 `prompt_cache_key`——键只
 * 影响路由，让共享同一段前缀的请求尽量落到同一台机器上。GPT-5.6 官方端点还在最后
 * 一个稳定区块后放显式 breakpoint，同时保留 implicit 模式：显式断点服务跨回复的
 * 稳定前缀，隐式断点服务同一回复内持续增长的工具往返。兼容端点与更早模型不发送
 * 这些新字段。`prompt_cache_key` 的分段哈希约定见 openai/promptCacheKey.ts。
 */
export function createOpenAiReplySession(
  { stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const content: OpenAI.Responses.ResponseInputContent[] = [];
  let breakpointTarget: OpenAI.Responses.ResponseInputText | undefined;
  for (let index: number = 0; index < stableBlocks.length; index += 1) {
    const text: string | undefined = stableBlocks[index];
    if (text === undefined) continue;
    if (index === stableBlocks.length - 1) {
      breakpointTarget = { type: "input_text", text, prompt_cache_breakpoint: undefined };
      content.push(breakpointTarget);
    } else {
      content.push({ type: "input_text", text });
    }
  }
  for (const text of volatileBlocks) content.push({ type: "input_text", text });
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content }];
  // 上一次 request() 拿到的模型 output item，等 appendToolOutputs() 接回 input。
  let pendingModelItems: OpenAI.Responses.ResponseInputItem[] | undefined;

  // prompt_cache_key 按工具形态记忆化：一轮回复里工具集合通常从头到尾不变（只有
  // 动作预算或检索额度耗尽时才换一份），没必要每轮重算一次几十 KB 的 SHA-256。
  // 指纹覆盖本端自动前缀缓存能复用的完整稳定段，包括参考记忆。
  let cacheKey: string | undefined;
  let keyedFunctions: readonly AiToolDefinition[] | undefined;
  let keyedWebSearchEnabled: boolean | undefined;
  let keyedSystemPrompt: string | undefined;

  /**
   * 取本轮请求的 prompt_cache_key，工具形态没变就复用上一次算好的。
   *
   * Responses 的自动前缀缓存覆盖 instructions → tools → input 的整段前缀，其中
   * 包含按群变化的参考记忆，所以键必须**按群分**，让同一个群的请求落到同一台
   * 机器上。键含参考记忆还顺带避免单键过热——OpenAI 文档明确要求高流量的分组
   * 拆成更多键。
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
      // 请求体在 requestOpenAiResult 的 try 内构造：模型名来自 config/agent.json，
      // 那份文件写坏时解析会抛，构造留在这里就等于让异常绕过整条 ok:false 通路
      // （见 client.ts 的 requestOpenAiResult 与 config/readiness.ts 的闸门）。
      const tools: OpenAI.Responses.Tool[] = buildTools(request);
      const promptCacheKey: string = promptCacheKeyFor(request, tools);
      const result: OpenAiRequestResult = await requestOpenAiResult({
        capability: "text",
        buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => {
          const config: AgentCapabilityConfig = getAgentDeploymentConfig().text;
          const useBreakpoints: boolean =
            breakpointTarget !== undefined && supportsPromptCacheBreakpoints(config);
          if (breakpointTarget !== undefined) {
            breakpointTarget.prompt_cache_breakpoint = useBreakpoints
              ? { mode: "explicit" }
              : undefined;
          }
          return {
            model: config.model,
            instructions: request.systemPrompt,
            input,
            tools,
            // 只影响路由：让共享同一段稳定前缀的请求尽量落到同一台机器上，
            // 自动前缀缓存才有机会读到那一段（见 consts/aiChat/openai.ts）。
            prompt_cache_key: promptCacheKey,
            // implicit 保留最新 user/tool 消息的自动断点；稳定区块末尾的显式断点
            // 让下一轮回复即使易变后缀不同，也能复用此前缀。
            prompt_cache_options: useBreakpoints
              ? { mode: "implicit", ttl: OPENAI_PROMPT_CACHE_TTL }
              : undefined,
            // 不带 temperature：GPT-5 系推理模型只接受默认值，传别的会直接
            // 400，因此 request.grounded 在本包不影响采样（见本文件头注）。
            max_output_tokens: OPENAI_REPLY_MAX_TOKENS,
            store: OPENAI_STORE_RESPONSES,
          };
        },
        errorLabel: OPENAI_REPLY_ERROR_LABEL,
        signal,
      });

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
