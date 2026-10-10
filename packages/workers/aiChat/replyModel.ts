import { getPersona } from "../../config/persona";
import {
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_WEB_SEARCH_CALLS_PER_REPLY,
  MAX_TOOL_ROUNDS,
} from "../../consts/aiChat/tools";
import {
  CHAT_INTERACTION_INSTRUCTION,
  CHAT_MEMORY_PRIORITY_INSTRUCTION,
  DIRECT_INVOCATION_READING_INSTRUCTION,
  MEMORY_MECHANISM_SILENCE_INSTRUCTION,
  REPLY_CONTEXT_STRUCTURE_INSTRUCTION,
  TRANSCRIPT_FORMAT_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { AI_CHAT_AGENT_ROLE_INSTRUCTION } from "../../consts/aiChat/prompts/agent";
import { WEB_SEARCH_FUNCTION_INSTRUCTION, WEB_SEARCH_INSTRUCTION } from "../../consts/aiChat/prompts/search";
import { logger } from "../../infra/logger";
import { textAiProvider } from "../../aiChat/provider";
import { TOOL_BUDGET_EXHAUSTED_RESULT, WEB_SEARCH_TOOL } from "../../consts/tools";
import { callTool } from "../../aiChat/ai/tools";
import { diagnosticWithDetails } from "../../aiChat/ai/utils/finishDetails";
import type { ReplyPromptSections, ReplyToolset, WebSearchToolOutcome } from "../../types/aiChat/replies";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplyTurn,
  AiToolOutput,
} from "../../types/aiChat/provider";
import { buildRuntimeStateBlock } from "./runtimeState";

/**
 * 一轮 AI 回复的模型往返编排。收发本身由当前选中的供应商实现包负责（见
 * aiChat/provider.ts 与各供应商实现包的 replySession.ts），本文件只管与供应商
 * 无关的那部分：系统提示词分段拼装、整轮函数调用预算、检索额度记账、
 * 工具轮数硬顶，以及每一轮把函数结果喂回会话。
 *
 * **一轮回复内 `functions` 与 `webSearchEnabled` 逐字恒定**，供应商的前缀缓存按
 * `systemInstruction/instructions → tools → 输入` 的顺序比对。各类上限因此只在执行侧
 * 兑现：动作硬顶由 toolset.execute 返回错误（见
 * aiChat/ai/tools/replyToolset/orchestrator.ts），整轮函数调用预算由本文件按调用
 * 逐次回「预算耗尽」，内建检索额度是写进提示词的软限制、只记账不摘工具。唯一的
 * 例外是供应商报服务端工具调用超限后的那一次降级重试（见 toolCallLimitHit 分支）。
 *
 * toolset 包含 packages/aiChat/ai/tools 的静态查询函数（如东京天气）和
 * 行动工具（发言、反应、两层贴纸、问答查询，部署配置了时的生图与语音）。工具清单
 * 跨回复同样恒定：按轮变化的可用性写进运行时状态区块的本轮工具状态
 * （toolset.toolStatus），执行器在调用时兜底拒绝。可见副作用在接纳后的独立调用链内
 * 发生。联网检索二选一：没配 web_search 能力时由 toolset.webSearch 声明 text 模型的服务端
 * 检索、由供应商执行；配了时 `web_search` 是本地函数工具，由本文件 await toolset.searchWeb
 * 取得结果后再喂回模型（执行器自带每轮次数硬顶，见 aiChat/ai/tools/webSearch.ts）。
 *
 * 当前时间、今天的心情与本轮工具状态拼进 user 内容的运行时状态区块（见 runtimeState.ts），
 * 转录行自带每条消息的发送时间（见 aiChat/ai/utils/chatTranscript.ts 的
 * formatBufferedMessageLine）。系统提示词逐字恒定，不含这些内容。
 */

function toolCountsDiagnostic(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()].sort(([left]: [string, number], [right]: [string, number]): number => left.localeCompare(right))
    .map(([name, count]: [string, number]): string => `${name}:${count}`).join(",") || "none";
}

/** 拼装一轮回复的系统提示词；同一回复的全部工具往返复用这一份字符串。 */
function buildReplySystemPrompt(toolset: ReplyToolset): string {
  // 人设是 init 接管的本进程快照，「行动与停止」段取自组装工具时的同一份台词语言快照。
  return `${getPersona()}\n\n## Agent 身份与权限边界\n${AI_CHAT_AGENT_ROLE_INSTRUCTION}\n\n` +
    `${CHAT_INTERACTION_INSTRUCTION}\n\n` +
    `## 上下文区块与记忆\n${REPLY_CONTEXT_STRUCTURE_INSTRUCTION}\n` +
    // 上下文结构后依次声明转录格式、两层仲裁与直接唤起的读取顺序。
    `${TRANSCRIPT_FORMAT_INSTRUCTION}\n${CHAT_MEMORY_PRIORITY_INSTRUCTION}\n` +
    `${DIRECT_INVOCATION_READING_INSTRUCTION}\n${MEMORY_MECHANISM_SILENCE_INSTRUCTION}\n\n` +
    `## 行动与停止\n${toolset.replyActionInstruction}\n\n` +
    `## 联网查证\n${toolset.searchWeb === null ? WEB_SEARCH_INSTRUCTION : WEB_SEARCH_FUNCTION_INSTRUCTION}`;
}

/** 一轮回复内跨工具轮累积的调用计数，只在 generateReply 与 runFunctionCalls 之间传递。 */
interface ReplyCallCounters {
  /** 计入 grounded 与检索软额度的次数：服务端内建检索加本地 web_search 函数的实际检索。 */
  webSearchCalls: number;
  /** 本轮函数调用总数，含超出整轮预算、只拿到「预算耗尽」的调用。 */
  customToolCalls: number;
  /** 按函数名的调用次数，只用于诊断日志。 */
  readonly customToolCallsByName: Map<string, number>;
}

/**
 * 按模型顺序校验与接纳一轮函数调用，返回逐条喂回模型的结果；动作回接纳结果，查看与查询
 * 回真实数据。拟人停顿、语音合成、投递调用链和 Telegram 排队都不参与本次模型往返的等待。
 * 每次调用前与 await 检索之后复核 toolset.isActive()，本轮作废时返回 null。
 */
async function runFunctionCalls(
  functionCalls: readonly AiFunctionCall[],
  toolset: ReplyToolset,
  counters: ReplyCallCounters
): Promise<AiToolOutput[] | null> {
  const outputs: AiToolOutput[] = [];
  for (const call of functionCalls) {
    if (!toolset.isActive()) return null;
    counters.customToolCalls++;
    const perNameCalls: number = (counters.customToolCallsByName.get(call.name) ?? 0) + 1;
    counters.customToolCallsByName.set(call.name, perNameCalls);
    const withinBudget: boolean = counters.customToolCalls <= MAX_CUSTOM_TOOL_CALLS_PER_REPLY;
    let toolResult: string;
    if (!withinBudget) {
      toolResult = TOOL_BUDGET_EXHAUSTED_RESULT;
    } else if (call.name === WEB_SEARCH_TOOL && toolset.searchWeb !== null) {
      // 唯一要等结果的工具：检索结论喂回模型后它才能接着说；本地检索计入 grounded。
      const outcome: WebSearchToolOutcome = await toolset.searchWeb(call.argumentsJson);
      if (!toolset.isActive()) return null;
      counters.webSearchCalls += outcome.searchCalls;
      toolResult = outcome.result;
    } else {
      toolResult = toolset.has(call.name)
        ? toolset.execute(call.name, call.argumentsJson)
        : callTool(call.name);
    }
    outputs.push({ call, responseJson: toolResult });
  }
  return outputs;
}

/**
 * 跑完一轮回复对话。
 * @param chatId 群聊 ID，用于诊断日志，并交给回复会话（Gemini 按群记录请求触发时刻）。
 * @param promptSections promptContext.ts 拼好的只读参考记忆、当前会话与本轮
 *   回复任务；这三段恒定出现，直接触发只体现为回复任务开头多一句唤起者声明。
 *   本文件在转录与回复任务之间补上第四段运行时状态（心情、当前时间与本轮工具状态）。
 * @param toolset 本轮回复的行动工具集（见 createReplyToolset），工具的执行
 *   副作用（发消息/贴纸/反应/图片/语音）都发生在它内部；toolset.functions
 *   直接传给供应商会话。
 * @returns 模型最后一轮的正文文本（正常情况下模型已通过工具把话说完、正文
 *   为空）；请求失败、超时、被 token 上限腰斩、空输出、工具结果无法续接或本轮
 *   作废时返回 null，除作废外都已在这里记下具体原因。调用方只在模型没有接纳任何
 *   可见动作时才把它经 send_message 当兜底回复用。
 */
export async function generateReply(
  chatId: number,
  promptSections: ReplyPromptSections,
  toolset: ReplyToolset
): Promise<string | null> {
  if (!toolset.isActive()) return null;
  const staticSystemPrompt: string = buildReplySystemPrompt(toolset);

  // 稳定区块只有参考记忆，跨回复逐字不变。其余三段随回复而变；运行时状态在回复开始时
  // 读取一次，同一回复的工具往返复用同一个字符串。转录已定切点随当前会话一起交给
  // 实现包，只有在区块边界命中缓存的实现会用它。
  const session: AiReplySession = textAiProvider().createReplySession({
    chatId,
    stableBlocks: [promptSections.referenceMemory],
    volatileBlocks: [
      promptSections.currentConversation,
      buildRuntimeStateBlock(toolset.toolStatus),
      promptSections.replyTask,
    ],
    conversationSettledOffsets: promptSections.currentConversationSettledOffsets,
    signal: toolset.signal,
  });

  const counters: ReplyCallCounters = {
    webSearchCalls: 0,
    customToolCalls: 0,
    customToolCallsByName: new Map<string, number>(),
  };
  // 只由 toolCallLimitHit 的降级重试置位；置位后 webSearchEnabled 恒为假，降级分支
  // 不再进入，降级至多发生一次。
  let searchDisabledByFallback: boolean = false;

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (!toolset.isActive()) return null;
    const webSearchEnabled: boolean = toolset.webSearch && !searchDisabledByFallback;

    toolset.beforeModelRequest();
    const turn: AiReplyTurn = await session.request({
      systemPrompt: staticSystemPrompt,
      // 整轮同一份声明，按引用透传；预算耗尽后模型的调用由执行侧返回错误或「预算耗尽」。
      functions: toolset.functions,
      webSearchEnabled,
      // 只传语义标志，采样参数由各实现包决定；搜索与首次成文发生在同一次请求里时，
      // 该轮按未查证处理。
      grounded: counters.webSearchCalls > 0,
    });
    if (!toolset.isActive()) return null;

    if (!turn.ok) {
      logger.error(
        `AI reply unusable response for chat ${chatId}: round=${round}, ` +
        `custom_calls=${counters.customToolCalls}, per_tool=${toolCountsDiagnostic(counters.customToolCallsByName)}, ` +
        `server_tool_invocations=${turn.webSearchCalls}, ` +
        `${diagnosticWithDetails(`finish_reason=${turn.finishReason ?? "?"}`, turn.finishDetails)}, ` +
        `side_effects=${toolset.actionsUsed()}.`
      );
      // 降级重试是本轮唯一一次改变工具形态；已经产生过副作用时不降级重试。
      if (turn.toolCallLimitHit && webSearchEnabled && toolset.actionsUsed() === 0) {
        searchDisabledByFallback = true;
        logger.error(
          `AI reply hit the provider's server-side tool-call limit for chat ${chatId}; retrying once with web search disabled.`
        );
        continue;
      }
      return null;
    }

    if (turn.webSearchCalls > 0) {
      const previousCalls: number = counters.webSearchCalls;
      counters.webSearchCalls += turn.webSearchCalls;
      // text 内建检索额度是写进提示词的软限制（见 consts/aiChat/prompts/search.ts）：超了
      // 只记账、不摘工具；只在跨过阈值的那一次记日志。
      if (previousCalls <= MAX_WEB_SEARCH_CALLS_PER_REPLY && counters.webSearchCalls > MAX_WEB_SEARCH_CALLS_PER_REPLY) {
        logger.error(
          `AI reply exceeded the soft web search budget for chat ${chatId}: ` +
          `${counters.webSearchCalls} server-side call(s) against a budget of ${MAX_WEB_SEARCH_CALLS_PER_REPLY}.`
        );
      }
    }

    const functionCalls: readonly AiFunctionCall[] = turn.functionCalls;
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      const outputs: AiToolOutput[] | null = await runFunctionCalls(functionCalls, toolset, counters);
      if (outputs === null) return null;
      // 供应商交不出可续接的模型轮次时到此为止，不再发请求。
      if (!session.appendToolOutputs(outputs)) {
        logger.error(
          `AI reply session could not continue after tool outputs for chat ${chatId}: round=${round}, ` +
          `custom_calls=${counters.customToolCalls}, side_effects=${toolset.actionsUsed()}.`
        );
        return null;
      }
      continue;
    }

    if (functionCalls.length > 0) {
      // 只在 round === MAX_TOOL_ROUNDS 时走到：这些调用不再执行，本轮就此收尾。
      logger.error(`AI reply for chat ${chatId} hit the tool-round limit (${MAX_TOOL_ROUNDS}) with ${functionCalls.length} unexecuted tool call(s); ending the round.`);
    }

    return turn.text;
  }

  return null;
}
