import { getPersona } from "../../config/persona";
import {
  HARD_MAX_ACTIONS_PER_REPLY,
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
  TIME_AWARENESS_INSTRUCTION,
  TRANSCRIPT_FORMAT_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { AI_CHAT_AGENT_ROLE_INSTRUCTION } from "../../consts/aiChat/prompts/agent";
import { ACTION_TOOL_NAMES } from "../../consts/tools";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import { WEB_SEARCH_INSTRUCTION } from "../../consts/aiChat/prompts/search";
import { REPLY_ACTION_INSTRUCTION } from "../../consts/aiChat/prompts/tools";
import { logger } from "../../infra/logger";
import { currentMoodInstruction } from "../../aiChat/ai/mood";
import { textAiProvider } from "../../aiChat/provider";
import { callTool } from "../../aiChat/ai/tools";
import type { ReplyPromptSections, ReplyToolset } from "../../types/aiChat/replies";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplyTurn,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";
import { currentTimeSentence } from "./timeSentence";

/**
 * 一轮 AI 回复的模型往返编排。收发本身由当前选中的供应商实现包负责（见
 * aiChat/provider.ts 与两个实现包的 replySession.ts），本文件只管与供应商
 * 无关的那部分：系统提示词分段拼装、工具预算与禁用名单、检索额度核销、
 * 工具轮数硬顶，以及每一轮把函数结果喂回会话。
 *
 * toolset 包含 packages/aiChat/ai/tools 的静态查询函数（当前为东京天气）和
 * 按轮组装的行动工具（发言、反应、两层贴纸及符合资格时的生图/生歌）；可见
 * 副作用在工具执行时发生。服务端检索工具由 toolset.webSearch 单独声明，并由
 * 供应商执行。
 *
 * 查时间不走工具：当前时间默认拼进每次请求的系统提示词（见下方），转录行也
 * 自带每条消息的发送时间（见 aiChat/ai/utils/chatTranscript.ts 的
 * formatBufferedMessageLine）。心情同样现查现拼：该群当前抽中的心情由
 * aiChat/ai/mood.ts 维护，currentMoodInstruction 读取时顺带处理到期重抽（只按
 * 随机寿命的时间区间轮换，与群是否活跃无关）。
 */

/** 按本轮预算与禁用名单过滤出这一次请求真正挂载的函数声明。 */
function availableFunctions(
  functions: readonly AiToolDefinition[],
  disabledNames: ReadonlySet<string>,
  allDisabled: boolean
): readonly AiToolDefinition[] {
  if (allDisabled) return [];
  if (disabledNames.size === 0) return functions;
  return functions.filter((definition: AiToolDefinition): boolean => !disabledNames.has(definition.name));
}

function toolCountsDiagnostic(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()].sort(([left]: [string, number], [right]: [string, number]): number => left.localeCompare(right))
    .map(([name, count]: [string, number]): string => `${name}:${count}`).join(",") || "none";
}

/**
 * 返回仓库根目录 prompt/persona.md 的人设文本。主线程启动总闸预先校验文件，
 * AI Worker 在自己的 isolate 中首次回复时读取并缓存。
 */
function systemPrompt(): string {
  return getPersona();
}

/**
 * 跑完一轮回复对话。
 * @param chatId 群聊 ID，用于取该群当前的心情（见 aiChat/ai/mood.ts 的
 *   currentMoodInstruction）。
 * @param promptSections promptContext.ts 拼好的只读参考记忆、当前会话与本轮
 *   回复任务；三段恒定出现，直接触发只体现为回复任务开头多一句唤起者声明。
 * @param toolset 本轮回复的行动工具集（见 createReplyToolset），工具的执行
 *   副作用（发消息/贴纸/反应/图片/歌曲）都发生在它内部；toolset.functions
 *   直接传给供应商会话。
 * @returns 模型最后一轮的正文文本（正常情况下模型已通过工具把话说完、正文
 *   为空）；请求失败、超时、被 token 上限腰斩或空输出时返回 null。调用方
 *   只在模型没有成功执行任何可见动作时才把它经 send_message 当兜底回复用。
 */
export async function generateReply(
  chatId: number,
  promptSections: ReplyPromptSections,
  toolset: ReplyToolset
): Promise<string | null> {
  if (!toolset.isActive()) return null;
  // 当前时间在回复开始时读取；同一回复的工具往返复用这一个完整字符串。
  // persona.md 与 CHAT_INTERACTION_INSTRUCTION 自带 Markdown 标题，其余
  // 运行时段落在此补同级的 ## 标题。
  const systemPromptPrefix: string =
    `${systemPrompt()}\n\n## Agent 身份与权限边界\n${AI_CHAT_AGENT_ROLE_INSTRUCTION}\n\n` +
    `${CHAT_INTERACTION_INSTRUCTION}\n\n` +
    `## 上下文区块与记忆\n${REPLY_CONTEXT_STRUCTURE_INSTRUCTION}\n` +
    // 上下文结构后依次声明转录格式、两层仲裁与直接唤起的读取顺序。
    `${TRANSCRIPT_FORMAT_INSTRUCTION}\n${CHAT_MEMORY_PRIORITY_INSTRUCTION}\n` +
    // 固定说明排在动态心情和当前时间之前，组成可缓存前缀。
    `${DIRECT_INVOCATION_READING_INSTRUCTION}\n${MEMORY_MECHANISM_SILENCE_INSTRUCTION}\n\n` +
    `## 行动与停止\n${REPLY_ACTION_INSTRUCTION}\n\n` +
    `## 联网查证\n${WEB_SEARCH_INSTRUCTION}\n\n` +
    `## 今天的状态\n${MOOD_STATE_PRECEDENCE_INSTRUCTION}\n${currentMoodInstruction(chatId)}\n\n` +
    `## 当前时间\n${currentTimeSentence()}${TIME_AWARENESS_INSTRUCTION}`;

  // 三个有序区块由实现包映射成同一个 user 轮次下的多段文本。
  const promptBlocks: string[] = [
    promptSections.referenceMemory,
    promptSections.currentConversation,
    promptSections.replyTask,
  ];
  const session: AiReplySession = textAiProvider().createReplySession({
    promptBlocks,
    signal: toolset.signal,
  });

  let webSearchCalls: number = 0;
  let customToolCalls: number = 0;
  const customToolCallsByName: Map<string, number> = new Map();
  const disabledFunctionNames: Set<string> = new Set();
  let searchLimitFallbackUsed: boolean = false;

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (!toolset.isActive()) return null;
    if (toolset.actionsUsed() >= HARD_MAX_ACTIONS_PER_REPLY) {
      for (const name of ACTION_TOOL_NAMES) disabledFunctionNames.add(name);
    }
    const remainingSearchCalls: number = Math.max(0, MAX_WEB_SEARCH_CALLS_PER_REPLY - webSearchCalls);
    const webSearchEnabled: boolean = toolset.webSearch && remainingSearchCalls > 0;

    const turn: AiReplyTurn = await session.request({
      systemPrompt: systemPromptPrefix,
      functions: availableFunctions(
        toolset.functions,
        disabledFunctionNames,
        customToolCalls >= MAX_CUSTOM_TOOL_CALLS_PER_REPLY
      ),
      webSearchEnabled,
      // 只给语义，不给温度：已经查证过的轮次该怎么压低采样随机性由各实现包
      // 决定（OpenAI 侧的推理模型根本不接受该参数）。搜索与首次成文发生在
      // 同一次请求里，那一轮无法预知，因此仍按未查证处理。
      grounded: webSearchCalls > 0,
    });
    if (!toolset.isActive()) return null;

    if (!turn.ok) {
      logger.error(
        `AI reply unusable response for chat ${chatId}: round=${round}, ` +
        `custom_calls=${customToolCalls}, per_tool=${toolCountsDiagnostic(customToolCallsByName)}, ` +
        `server_tool_invocations=${turn.webSearchCalls}, finish_reason=${turn.finishReason ?? "?"}, ` +
        `finish_message=${JSON.stringify((turn.finishMessage ?? "").slice(0, 500))}, side_effects=${toolset.actionsUsed()}.`
      );
      if (turn.toolCallLimitHit && webSearchEnabled) {
        webSearchCalls = MAX_WEB_SEARCH_CALLS_PER_REPLY;
        if (!searchLimitFallbackUsed && toolset.actionsUsed() === 0) {
          searchLimitFallbackUsed = true;
          logger.error(
            `AI reply hit the provider's server-side tool-call limit for chat ${chatId}; retrying once with web search disabled.`
          );
          continue;
        }
      }
      return null;
    }

    if (turn.webSearchCalls > 0) {
      const allowedThisRequest: number = remainingSearchCalls;
      webSearchCalls = Math.min(
        MAX_WEB_SEARCH_CALLS_PER_REPLY,
        webSearchCalls + turn.webSearchCalls
      );
      if (turn.webSearchCalls > allowedThisRequest) {
        logger.error(
          `AI reply exceeded the web search budget for chat ${chatId}: ` +
          `observed ${turn.webSearchCalls} server-side call(s) with ${allowedThisRequest} remaining; disabling search.`
        );
      }
    }

    const functionCalls: readonly AiFunctionCall[] = turn.functionCalls;
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      // 同一轮的多个调用按序执行——模型并行抛出「先发言后贴纸」时，落地
      // 顺序与它给出的顺序一致。结果攒齐后一次性喂回会话（会话自己负责把
      // 模型这一轮的输出原样接回，见各实现包的 appendToolOutputs）。
      const outputs: AiToolOutput[] = [];
      for (const call of functionCalls) {
        if (!toolset.isActive()) return null;
        customToolCalls++;
        const perNameCalls: number = (customToolCallsByName.get(call.name) ?? 0) + 1;
        customToolCallsByName.set(call.name, perNameCalls);
        const withinBudget: boolean = customToolCalls <= MAX_CUSTOM_TOOL_CALLS_PER_REPLY;
        const toolResult: string = withinBudget
          ? toolset.has(call.name)
            ? await toolset.execute(call.name, call.argumentsJson)
            : callTool(call.name)
          : JSON.stringify({ unavailable: "Tool budget exhausted for this reply" });
        if (toolset.actionsUsed() >= HARD_MAX_ACTIONS_PER_REPLY) {
          for (const name of ACTION_TOOL_NAMES) disabledFunctionNames.add(name);
        }
        outputs.push({ call, responseJson: toolResult });
      }
      // 供应商交不出可续接的模型轮次时到此为止：再发一次请求只会让对话记录
      // 与模型实际看到的历史错位。
      if (!session.appendToolOutputs(outputs)) return null;
      continue;
    }

    if (functionCalls.length > 0) {
      // 只可能在 round === MAX_TOOL_ROUNDS 时走到：模型仍在要工具但轮数
      // 上限已到，这些调用不再执行，本轮就此收尾（多半以零动作告终）。
      logger.error(`AI reply for chat ${chatId} hit the tool-round limit (${MAX_TOOL_ROUNDS}) with ${functionCalls.length} unexecuted tool call(s); ending the round.`);
    }

    return turn.text;
  }

  return null;
}
