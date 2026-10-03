/**
 * Anthropic 侧的一轮回复会话：把中立的 AiReplySession 契约落到 Messages API 的手动工具循环上。
 *
 * 多轮工具往返在本地累积 messages：模型这一轮的 assistant 内容原样接回，再挂一条 user 消息放
 * 各 `tool_result`（`tool_use_id` 是两者之间唯一的关联键）。联网查证走内建的
 * `web_search_20260209`，`allowed_callers: ["direct"]`；检索在服务端执行，次数按用量或成功的
 * 检索结果块统计。服务端工具循环到达迭代上限时返回 `pause_turn`，本会话把已得
 * 内容作为 assistant 续写前缀再发，最多 ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS 次，续出的内容与
 * 前缀合并成同一个 assistant 轮次。
 *
 * 缓存：Messages API 只在区块边界命中、至多 4 个断点，本会话按以下位置各打一个
 * `cache_control`：
 * - 系统提示词块末尾：「工具 + 系统提示词」这段跨群共用的静态前缀；
 * - 最后一个稳定区块末尾：同群跨轮回复不变的参考记忆；
 * - 当前会话按 conversationSettledOffsets 切开后的最后一个已定段末尾：转录里按消息序号对齐、
 *   下一轮通常逐字重现的那段前缀；上一轮在更早格边界写下的条目由端点的回看接住；
 * - 请求顶层的自动断点：落在本次请求的最后一个区块上，同一轮后续请求整段读回上一次请求。
 * 切分只改变区块边界，拼起来与原区块逐字相同。最小可缓存长度随模型不同，不足时端点照常
 * 处理、只是不缓存。
 *
 * 请求不带采样温度：中立契约的 `grounded` 在本包不影响采样。
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS,
  ANTHROPIC_REPLY_ERROR_LABEL,
  ANTHROPIC_REPLY_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from "../../consts/aiChat/anthropic";
import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestAnthropicMessage } from "./client";
import { countAnthropicWebSearches, messageText, toolUseCalls } from "./response";
import type { AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type {
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";

/** 中立工具声明转 Messages 的自定义工具；参数 JSON Schema 按引用透传。 */
function toCustomTool(definition: AiToolDefinition): Anthropic.Tool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.parametersJsonSchema as Anthropic.Tool.InputSchema,
  };
}

/** 按本轮配置拼请求要挂的工具集合：内建检索在前，自定义工具在后。 */
function buildTools(request: AiReplyTurnRequest): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [];
  if (request.webSearchEnabled) {
    tools.push({ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] });
  }
  for (const definition of request.functions) tools.push(toCustomTool(definition));
  return tools;
}

/** 一轮失败的回复；成功与失败按同一顺序初始化同一组字段。 */
function failedTurn(webSearchCalls: number, finishReason: string | undefined): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: EMPTY_FUNCTION_CALLS,
    webSearchCalls,
    finishReason,
    finishMessage: undefined,
    // Anthropic 没有「服务端工具调用过多」的对等信号；fail-safe 含义同 OpenAI 侧。
    toolCallLimitHit: false,
  };
}

/**
 * 把当前会话按已定切点切成多个文本块追加到 content；最后一个已定段带缓存断点，切点之后的
 * 余段不带。没有切点时整块原样追加。
 */
function pushConversationSegments(
  content: Anthropic.TextBlockParam[],
  text: string,
  settledOffsets: readonly number[]
): void {
  let start: number = 0;
  for (let index: number = 0; index < settledOffsets.length; index++) {
    const end: number = settledOffsets[index]!;
    const segment: string = text.slice(start, end);
    content.push(index === settledOffsets.length - 1
      ? { type: "text", text: segment, cache_control: { type: "ephemeral" } }
      : { type: "text", text: segment });
    start = end;
  }
  content.push({ type: "text", text: text.slice(start) });
}

/**
 * 建立一轮 Anthropic 回复会话。会话随本轮结束即弃，不跨轮复用。稳定区块与易变区块按顺序拼进
 * 同一个 user 轮次：最后一个稳定区块带缓存断点，易变组第一个区块（当前会话）按已定切点切开。
 */
export function createAnthropicReplySession(
  { stableBlocks, volatileBlocks, conversationSettledOffsets = [], signal }: AiReplySessionParams
): AiReplySession {
  const content: Anthropic.TextBlockParam[] = [];
  for (let index: number = 0; index < stableBlocks.length; index++) {
    const text: string = stableBlocks[index]!;
    content.push(index === stableBlocks.length - 1
      ? { type: "text", text, cache_control: { type: "ephemeral" } }
      : { type: "text", text });
  }
  for (let index: number = 0; index < volatileBlocks.length; index++) {
    const text: string = volatileBlocks[index]!;
    if (index === 0) pushConversationSegments(content, text, conversationSettledOffsets);
    else content.push({ type: "text", text });
  }
  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
  // 上一次 request() 拿到的 assistant 内容，等 appendToolOutputs() 接回 messages。
  let pendingAssistant: Anthropic.ContentBlockParam[] | undefined;

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingAssistant = undefined;
      const tools: Anthropic.ToolUnion[] = buildTools(request);
      const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } },
      ];
      let paused: Anthropic.ContentBlockParam[] | null = null;
      let webSearchCalls: number = 0;
      let text: string = "";
      for (let continuation: number = 0; ; continuation++) {
        const prefix: Anthropic.ContentBlockParam[] | null = paused;
        const result: AnthropicRequestResult = await requestAnthropicMessage({
          capability: "text",
          buildBody: (): Anthropic.MessageCreateParamsNonStreaming => {
            const model: string = getAgentDeploymentConfig().text.model;
            return {
              model,
              system,
              messages: prefix === null ? messages : [...messages, { role: "assistant", content: prefix }],
              tools,
              max_tokens: ANTHROPIC_REPLY_MAX_TOKENS,
              cache_control: { type: "ephemeral" },
            };
          },
          errorLabel: ANTHROPIC_REPLY_ERROR_LABEL,
          signal,
        });
        // 检索次数在失败分支也要统计：那一次请求已经把服务端调用花掉了。
        const searches: number = result.message === undefined ? 0 : countAnthropicWebSearches(result.message);
        webSearchCalls += searches;

        if (!result.ok) return failedTurn(webSearchCalls, result.failureKind === "response" ? result.stopReason : undefined);
        text += messageText(result.message);
        const blocks: Anthropic.ContentBlockParam[] = prefix === null
          ? result.message.content
          : [...prefix, ...result.message.content];
        if (result.message.stop_reason === "pause_turn") {
          if (continuation >= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS) return failedTurn(webSearchCalls, "pause_turn");
          paused = blocks;
          continue;
        }
        pendingAssistant = blocks;
        return {
          ok: true,
          text: text || null,
          functionCalls: toolUseCalls(result.message),
          webSearchCalls,
          finishReason: undefined,
          finishMessage: undefined,
          toolCallLimitHit: false,
        };
      }
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      if (pendingAssistant === undefined) return false;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const output of outputs) {
        results.push({ type: "tool_result", tool_use_id: output.call.id ?? "", content: output.responseJson });
      }
      messages.push({ role: "assistant", content: pendingAssistant }, { role: "user", content: results });
      pendingAssistant = undefined;
      return true;
    },
  };
}
