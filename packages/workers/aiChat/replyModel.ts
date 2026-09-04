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
import { WEB_SEARCH_INSTRUCTION } from "../../consts/aiChat/prompts/search";
import { REPLY_ACTION_INSTRUCTION } from "../../consts/aiChat/prompts/tools";
import { logger } from "../../infra/logger";
import { textAiProvider } from "../../aiChat/provider";
import { TOOL_BUDGET_EXHAUSTED_RESULT } from "../../consts/tools";
import { callTool } from "../../aiChat/ai/tools";
import type { ReplyPromptSections, ReplyToolset } from "../../types/aiChat/replies";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplyTurn,
  AiToolOutput,
} from "../../types/aiChat/provider";
import { buildRuntimeStateBlock } from "./runtimeState";

/**
 * 一轮 AI 回复的模型往返编排。收发本身由当前选中的供应商实现包负责（见
 * aiChat/provider.ts 与两个实现包的 replySession.ts），本文件只管与供应商
 * 无关的那部分：系统提示词分段拼装、整轮函数调用预算、检索额度记账、
 * 工具轮数硬顶，以及每一轮把函数结果喂回会话。
 *
 * **一轮回复内 `functions` 与 `webSearchEnabled` 逐字恒定**：两家供应商的前缀
 * 缓存都按 `systemInstruction/instructions → tools → 输入` 的顺序比对，工具形态
 * 中途改一次，从 tools 往后的整段（参考记忆、转录、运行时状态、本轮已累积的全部
 * 工具往返）就在剩余轮次里全部落空——而那正是上下文最长、最贵的时刻。因此各类
 * 上限一律只在执行侧兑现：动作硬顶由 toolset.execute 返回错误（见
 * aiChat/ai/tools/replyToolset/orchestrator.ts），整轮函数调用预算由本文件按调用
 * 逐次回「预算耗尽」，检索额度退化为写进提示词的软限制、只记账不摘工具。唯一的
 * 例外是供应商报服务端工具调用超限后的那一次降级重试（见 toolCallLimitHit 分支）：
 * 那一轮的响应本来就不可用，缓存已经无从谈起。
 *
 * toolset 包含 packages/aiChat/ai/tools 的静态查询函数（当前为东京天气）和
 * 按轮组装的行动工具（发言、反应、两层贴纸及符合资格时的生图/生歌）；可见
 * 副作用在工具执行时发生。服务端检索工具由 toolset.webSearch 单独声明，并由
 * 供应商执行。
 *
 * 查时间不走工具：当前时间与今天的心情拼进 user 内容的运行时状态区块（见
 * runtimeState.ts），转录行也自带每条消息的发送时间（见
 * aiChat/ai/utils/chatTranscript.ts 的 formatBufferedMessageLine）。两者都**不在**
 * 系统提示词里——那一段必须逐字恒定，才能连同工具声明一起被供应商缓存住。
 */

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
 * @param chatId 群聊 ID，用于取该群当前的心情（见 runtimeState.ts 的
 *   buildRuntimeStateBlock）。
 * @param promptSections promptContext.ts 拼好的只读参考记忆、当前会话与本轮
 *   回复任务；这三段恒定出现，直接触发只体现为回复任务开头多一句唤起者声明。
 *   本文件在转录与回复任务之间补上第四段运行时状态（心情与当前时间）。
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
  // 系统提示词整段逐字恒定——心情与当前时间已经挪进 user 内容的运行时状态区块
  // （见 runtimeState.ts）。这一条是供应商缓存的前提，别再往这里拼任何随时间、
  // 群或轮次变化的东西。persona.md 与 CHAT_INTERACTION_INSTRUCTION 自带 Markdown
  // 标题，其余段落在此补同级的 ## 标题。
  const staticSystemPrompt: string =
    `${systemPrompt()}\n\n## Agent 身份与权限边界\n${AI_CHAT_AGENT_ROLE_INSTRUCTION}\n\n` +
    `${CHAT_INTERACTION_INSTRUCTION}\n\n` +
    `## 上下文区块与记忆\n${REPLY_CONTEXT_STRUCTURE_INSTRUCTION}\n` +
    // 上下文结构后依次声明转录格式、两层仲裁与直接唤起的读取顺序。
    `${TRANSCRIPT_FORMAT_INSTRUCTION}\n${CHAT_MEMORY_PRIORITY_INSTRUCTION}\n` +
    `${DIRECT_INVOCATION_READING_INSTRUCTION}\n${MEMORY_MECHANISM_SILENCE_INSTRUCTION}\n\n` +
    `## 行动与停止\n${REPLY_ACTION_INSTRUCTION}\n\n` +
    `## 联网查证\n${WEB_SEARCH_INSTRUCTION}`;

  // 稳定区块只有参考记忆：它跨轮回复逐字不变，能延长供应商自动缓存的公共前缀。
  // 其余三段每轮都变，其中运行时状态在回复开始时读取一次，同一回复的工具
  // 往返复用同一个字符串（时间因此在一轮内自洽，不会逐轮跳秒）。
  const session: AiReplySession = textAiProvider().createReplySession({
    stableBlocks: [promptSections.referenceMemory],
    volatileBlocks: [
      promptSections.currentConversation,
      buildRuntimeStateBlock(chatId, toolset.imageReference),
      promptSections.replyTask,
    ],
    signal: toolset.signal,
  });

  let webSearchCalls: number = 0;
  let customToolCalls: number = 0;
  const customToolCallsByName: Map<string, number> = new Map();
  // 只由 toolCallLimitHit 的降级重试置位；除它以外本轮的工具形态恒定。置位后
  // webSearchEnabled 恒为假，那条分支不会再进来，因此它同时就是「只降级一次」的闸。
  let searchDisabledByFallback: boolean = false;

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (!toolset.isActive()) return null;
    const webSearchEnabled: boolean = toolset.webSearch && !searchDisabledByFallback;

    const turn: AiReplyTurn = await session.request({
      systemPrompt: staticSystemPrompt,
      // 整轮同一份声明，按引用透传：预算耗尽不再摘工具，模型多调一次只会拿到
      // 执行侧的错误或「预算耗尽」，前缀缓存不受影响。
      functions: toolset.functions,
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
      // 本轮唯一一次改变工具形态：这次响应已经不可用，与其保住一段没人能用上的
      // 前缀，不如换一个能出话的请求形态。已经产生过副作用就不再降级重试——那会
      // 让同一轮里的可见动作重来一遍。
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
      const previousCalls: number = webSearchCalls;
      webSearchCalls += turn.webSearchCalls;
      // 检索额度是写进提示词的软限制（见 consts/aiChat/prompts/search.ts）：超了
      // 只记账、不摘工具——服务端检索工具排在 tools 数组首位，中途摘掉会让整段
      // 前缀从第一个字节起就对不上。只在跨过阈值的那一次点名，不逐轮刷屏。
      if (previousCalls <= MAX_WEB_SEARCH_CALLS_PER_REPLY && webSearchCalls > MAX_WEB_SEARCH_CALLS_PER_REPLY) {
        logger.error(
          `AI reply exceeded the soft web search budget for chat ${chatId}: ` +
          `${webSearchCalls} server-side call(s) against a budget of ${MAX_WEB_SEARCH_CALLS_PER_REPLY}.`
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
          : TOOL_BUDGET_EXHAUSTED_RESULT;
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
