import { readFileSync } from "node:fs";
import type { Content, FunctionCall, FunctionDeclaration, GenerateContentResponse, Part, Tool } from "@google/genai";
import { systemPromptHolder } from "../../cache/workers/aiChat/prompts";
import { PERSONA_PATH } from "../../consts/paths";
import {
  GEMINI_REPLY_MODEL,
  GROUNDED_REPLY_TEMPERATURE,
  HARD_MAX_ACTIONS_PER_REPLY,
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_GOOGLE_SEARCH_CALLS_PER_REPLY,
  MAX_TOOL_ROUNDS,
  REPLY_MAX_TOKENS,
  REPLY_TEMPERATURE,
} from "../../consts/aiChat/tools";
import {
  CHAT_INTERACTION_INSTRUCTION,
  CHAT_MEMORY_PRIORITY_INSTRUCTION,
  REPLY_CONTEXT_STRUCTURE_INSTRUCTION,
  TIME_AWARENESS_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { ACTION_TOOL_NAMES } from "../../consts/tools";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import {
  buildGroundedWebSearchInstruction,
  buildWebSearchInstruction,
  WEB_SEARCH_EXHAUSTED_INSTRUCTION,
} from "../../consts/aiChat/prompts/search";
import { logger } from "../../infra/logger";
import { currentMoodInstruction } from "../../aiChat/ai/mood";
import { requestGeminiResult } from "../../aiChat/ai/gemini";
import { countGoogleSearchCalls } from "../../aiChat/ai/utils/geminiResponse";
import { callTool } from "../../aiChat/ai/tools";
import { isPlainRecord } from "../../libs/runtimeConfig";
import type { ReplyPromptSections, ReplyToolset } from "../../types/aiChat/replies";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import { currentTimeSentence } from "./timeSentence";

export interface AvailableToolsParams {
  googleSearchEnabled: boolean;
  disabledFunctionNames: ReadonlySet<string>;
  allFunctionsDisabled: boolean;
}

function availableTools(
  tools: Tool[],
  options: AvailableToolsParams
): Tool[] {
  const { googleSearchEnabled, disabledFunctionNames, allFunctionsDisabled }: AvailableToolsParams = options;
  const available: Tool[] = [];
  for (const tool of tools) {
    if (tool.googleSearch !== undefined) {
      if (googleSearchEnabled) available.push(tool);
      continue;
    }
    if (tool.functionDeclarations !== undefined) {
      if (allFunctionsDisabled) continue;
      const declarations: FunctionDeclaration[] = tool.functionDeclarations.filter((declaration: FunctionDeclaration): boolean =>
        typeof declaration.name === "string" && !disabledFunctionNames.has(declaration.name)
      );
      if (declarations.length > 0) available.push({ ...tool, functionDeclarations: declarations });
      continue;
    }
    available.push(tool);
  }
  return available;
}

function toolCountsDiagnostic(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()].sort(([left]: [string, number], [right]: [string, number]): number => left.localeCompare(right))
    .map(([name, count]: [string, number]): string => `${name}:${count}`).join(",") || "none";
}

/**
 * 人设文本存放在仓库根目录的 prompt/persona.md，修改人设不需要碰代码。
 * 惰性读一次并缓存——callGemini 是它唯一的消费者。
 *
 * 不在模块加载时读：那样文件缺失或不可读会在 aiChat Worker 的模块求值期抛出，
 * 监督者只看到一个不透明的 worker error 并按 WORKER_MAX_RESTARTS 反复重启，
 * 没有任何一行指向 prompt/persona.md。同 config/adSamples.ts 的约定
 * （「模块 import 本身不访问文件系统」），配置类读盘一律推迟到第一次真正要用时。
 */
function systemPrompt(): string {
  systemPromptHolder.current ??= readFileSync(PERSONA_PATH, "utf8").trim();
  return systemPromptHolder.current;
}

/**
 * 调用 Gemini 的 generateContent 接口跑完一轮回复对话（收发与响应解析在
 * aiChat/ai/gemini.ts）。toolset.tools 带三类，组装见 aiChat/ai/tools/replyToolset/orchestrator.ts 的
 * createReplyToolset：内置的 googleSearch（Google 服务器侧自动执行，模型
 * 自主决定要不要联网查证）+ packages/aiChat/ai/tools 里的静态自定义函数（目前是查东京
 * 天气）+ 按次回复现组装的行动工具集（发言/反应/两层贴纸——发消息、发贴纸
 * 这些副作用动作都在工具执行时当场发生，不再等最终文本）。自定义函数由
 * 模型以 functionCall part 抛回来，执行后把上一轮模型的整个 content 原样
 * 接回 contents、附上 functionResponse 再续跑（content 里的 thought
 * signature 也要一并带回，缺了会丢思考上下文），直到模型不再要工具或达到
 * 轮数上限。查时间不走工具：当前时间默认拼进每次请求的系统提示词（见
 * 下方），转录行也自带每条消息的发送时间（见 aiChat/ai/utils/chatTranscript.ts 的
 * formatBufferedMessageLine）。心情同样现查现拼：该群当前抽中的心情由
 * aiChat/ai/mood.ts 维护，currentMoodInstruction 读取时顺带处理到期重抽（只按
 * 随机寿命的时间区间轮换，与群是否活跃无关）。
 * @param chatId 群聊 ID，用于取该群当前的心情（见 aiChat/ai/mood.ts 的
 *   currentMoodInstruction）。
 * @param promptSections promptContext.ts 拼好的只读参考记忆、当前会话、可选的
 *   直接唤起者重点记录与回复任务。
 * @param toolset 本轮回复的行动工具集（见 createReplyToolset），工具的执行
 *   副作用（发消息/贴纸/反应/图片）都发生在它内部；toolset.tools 直接透传给
 *   请求，本函数不再自己组装。
 * @returns 模型最后一轮的正文文本（正常情况下模型已通过工具把话说完、正文
 *   为空）；请求失败、超时、被 token 上限腰斩或空输出时返回 null。调用方
 *   只在模型没有成功执行任何可见动作时才把它经 send_message 当兜底回复用。
 */
export async function callGemini(
  chatId: number,
  promptSections: ReplyPromptSections,
  toolset: ReplyToolset
): Promise<string | null> {
  if (!toolset.isActive()) return null;
  // 每次请求现查当前时间拼进系统提示词（而非用模块加载时算好的值），worker
  // 线程常驻、一跑就是几天，缓存的时间会很快过期。persona.md 与
  // CHAT_INTERACTION_INSTRUCTION 自带 Markdown 标题，其余运行时段落在此补
  // 同级的 ## 标题，避免按 Markdown 层级全部挂进「上下文与互动规则」小节。
  const systemPromptPrefix: string =
    `${systemPrompt()}\n\n${CHAT_INTERACTION_INSTRUCTION}\n\n` +
    `## 上下文区块与记忆\n${REPLY_CONTEXT_STRUCTURE_INSTRUCTION}\n${CHAT_MEMORY_PRIORITY_INSTRUCTION}\n\n` +
    `## 今天的状态\n${MOOD_STATE_PRECEDENCE_INSTRUCTION}\n${currentMoodInstruction(chatId)}\n\n` +
    `## 当前时间\n${currentTimeSentence()}${TIME_AWARENESS_INSTRUCTION}`;
  const initialParts: Part[] = [
    { text: promptSections.referenceMemory },
    { text: promptSections.currentConversation },
    ...(promptSections.invokerFocus ? [{ text: promptSections.invokerFocus }] : []),
    { text: promptSections.replyTask },
  ];
  const contents: Content[] = [{
    role: "user",
    parts: initialParts,
  }];
  const hasGoogleSearch: boolean = toolset.tools.some((tool: Tool): boolean => tool.googleSearch !== undefined);
  let googleSearchCalls: number = 0;
  let customToolCalls: number = 0;
  const customToolCallsByName: Map<string, number> = new Map();
  const disabledFunctionNames: Set<string> = new Set();
  let searchLimitFallbackUsed: boolean = false;

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (!toolset.isActive()) return null;
    if (toolset.actionsUsed() >= HARD_MAX_ACTIONS_PER_REPLY) {
      for (const name of ACTION_TOOL_NAMES) disabledFunctionNames.add(name);
    }
    const remainingSearchCalls: number = Math.max(0, MAX_GOOGLE_SEARCH_CALLS_PER_REPLY - googleSearchCalls);
    const googleSearchEnabled: boolean = hasGoogleSearch && remainingSearchCalls > 0;
    const requestTools: Tool[] = availableTools(
      toolset.tools,
      {
        googleSearchEnabled,
        disabledFunctionNames,
        allFunctionsDisabled: customToolCalls >= MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
      }
    );
    // 联网查证说明分三态：还没搜过（讲该不该搜）、已经搜过且有余额（讲结果
    // 怎么用、缺口怎么补搜）、额度耗尽（讲结果怎么用、查不到怎么收口）。
    // 搜完之后继续喂「你该不该搜」的文案，等于整轮没有一句话约束模型必须照
    // 搜索结果回答，见 consts/aiChat/prompts/search.ts。
    const searchInstruction: string = googleSearchEnabled
      ? googleSearchCalls > 0
        ? buildGroundedWebSearchInstruction(remainingSearchCalls)
        : buildWebSearchInstruction(remainingSearchCalls)
      : WEB_SEARCH_EXHAUSTED_INSTRUCTION;
    const systemPrompt: string = `${systemPromptPrefix}\n\n## 联网查证\n${searchInstruction}`;
    const result: GeminiRequestResult = await requestGeminiResult(
      {
        model: GEMINI_REPLY_MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          abortSignal: toolset.signal,
          tools: requestTools,
          // googleSearch 与函数工具混用时必须要求 SDK 把服务端工具调用记录
          // 接回 content；否则 Gemini API 会拒绝该组合或丢失搜索上下文。
          toolConfig: googleSearchEnabled ? { includeServerSideToolInvocations: true } : undefined,
          // 已经查证过的轮次压低采样随机性，让模型照搜索结果讲；搜索与首次
          // 成文发生在同一次请求里，那一轮无法预知，仍按常规温度生成。
          temperature: googleSearchCalls > 0 ? GROUNDED_REPLY_TEMPERATURE : REPLY_TEMPERATURE,
          maxOutputTokens: REPLY_MAX_TOKENS,
        },
      },
      "Gemini API"
    );
    if (!toolset.isActive()) return null;

    const diagnosticResponse: GenerateContentResponse | undefined = result.response;
    const observedSearchCalls: number = diagnosticResponse === undefined ? 0 : countGoogleSearchCalls(diagnosticResponse);
    if (!result.ok) {
      logger.error(
        `Gemini API unusable response for chat ${chatId}: round=${round}, ` +
        `custom_calls=${customToolCalls}, per_tool=${toolCountsDiagnostic(customToolCallsByName)}, ` +
        `server_tool_invocations=${observedSearchCalls}, finish_reason=${result.finishReason ?? "?"}, ` +
        `finish_message=${JSON.stringify((result.finishMessage ?? "").slice(0, 500))}, side_effects=${toolset.actionsUsed()}.`
      );
      if (result.finishReason === "TOO_MANY_TOOL_CALLS" && googleSearchEnabled) {
        googleSearchCalls = MAX_GOOGLE_SEARCH_CALLS_PER_REPLY;
        if (!searchLimitFallbackUsed && toolset.actionsUsed() === 0) {
          searchLimitFallbackUsed = true;
          logger.error(
            `Gemini API hit its server-side tool-call limit for chat ${chatId}; retrying once with Google Search disabled.`
          );
          continue;
        }
      }
      return null;
    }
    const data: GenerateContentResponse = result.response;

    if (observedSearchCalls > 0) {
      const allowedThisRequest: number = remainingSearchCalls;
      googleSearchCalls = Math.min(
        MAX_GOOGLE_SEARCH_CALLS_PER_REPLY,
        googleSearchCalls + observedSearchCalls
      );
      if (observedSearchCalls > allowedThisRequest) {
        logger.error(
          `Gemini API exceeded the Google Search budget for chat ${chatId}: ` +
          `observed ${observedSearchCalls} server-side call(s) with ${allowedThisRequest} remaining; disabling search.`
        );
      }
    }

    const functionCalls: (FunctionCall & { name: string })[] = (data.functionCalls ?? []).filter(
      (call: FunctionCall): call is FunctionCall & { name: string } => typeof call.name === "string"
    );
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      // 模型这一轮的 content 原样接回（缺了 thought signature 会丢思考
      // 上下文），随后所有函数结果合并成一个 user turn 的 functionResponse
      // parts 喂回去。同一轮的多个调用按序执行——模型并行抛出「先发言后
      // 贴纸」时，落地顺序与它给出的顺序一致。
      const modelContent: Content | undefined = data.candidates?.[0]?.content;
      if (!modelContent) return null;
      contents.push(modelContent);
      const responseParts: Part[] = [];
      for (const call of functionCalls) {
        if (!toolset.isActive()) return null;
        customToolCalls++;
        const perNameCalls: number = (customToolCallsByName.get(call.name) ?? 0) + 1;
        customToolCallsByName.set(call.name, perNameCalls);
        const withinBudget: boolean = customToolCalls <= MAX_CUSTOM_TOOL_CALLS_PER_REPLY;
        const toolResult: string = withinBudget
          ? toolset.has(call.name)
            ? await toolset.execute(call.name, JSON.stringify(call.args ?? {}))
            : callTool(call.name)
          : JSON.stringify({ unavailable: "Tool budget exhausted for this reply" });
        if (toolset.actionsUsed() >= HARD_MAX_ACTIONS_PER_REPLY) {
          for (const name of ACTION_TOOL_NAMES) disabledFunctionNames.add(name);
        }
        // 工具实现返回的都是 JSON 字符串（见 packages/aiChat/ai/tools），
        // functionResponse.response 要求对象，解析回来直接挂上。
        const response: unknown = JSON.parse(toolResult);
        if (!isPlainRecord(response)) throw new Error(`Tool ${call.name} returned a non-object JSON value`);
        responseParts.push({ functionResponse: { id: call.id, name: call.name, response } });
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    if (functionCalls.length > 0) {
      // 只可能在 round === MAX_TOOL_ROUNDS 时走到：模型仍在要工具但轮数
      // 上限已到，这些调用不再执行，本轮就此收尾（多半以零动作告终）。
      logger.error(`AI reply for chat ${chatId} hit the tool-round limit (${MAX_TOOL_ROUNDS}) with ${functionCalls.length} unexecuted tool call(s); ending the round.`);
    }

    return data.text || null;
  }

  return null;
}
