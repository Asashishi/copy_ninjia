import { readFileSync } from "node:fs";
import type { Content, GenerateContentResponse, Part } from "@google/genai";
import { PERSONA_PATH } from "../../consts/paths";
import {
  GEMINI_REPLY_MODEL,
  MAX_TOOL_ROUNDS,
  REPLY_MAX_TOKENS,
  REPLY_TEMPERATURE,
  TIME_AWARENESS_INSTRUCTION,
  WEB_SEARCH_INSTRUCTION,
} from "../../consts/aiChat";
import { currentMoodInstruction } from "../../ai/mood";
import { requestGeminiResponse } from "../../ai/gemini";
import { extractFunctionCalls, extractOutputText, isTruncatedByTokenLimit } from "../../ai/utils/geminiResponse";
import { callTool } from "../../ai/tools";
import type { ExtractedFunctionCall, ReplyToolset } from "../../types";
import { currentTimeSentence } from "./timeSentence";

/** 人设文本存放在仓库根目录的 prompt/persona.md，修改人设不需要碰代码。
 *  只在这里读一次（模块加载时）——callGemini 是它唯一的消费者。 */
const SYSTEM_PROMPT: string = readFileSync(PERSONA_PATH, "utf8").trim();

/**
 * 调用 Gemini 的 generateContent 接口跑完一轮回复对话（收发与响应解析在
 * ai/gemini.ts）。toolset.tools 带三类，组装见 ai/tools/replyToolset.ts 的
 * createReplyToolset：内置的 googleSearch（Google 服务器侧自动执行，模型
 * 自主决定要不要联网查证）+ src/ai/tools 里的静态自定义函数（目前是查东京
 * 天气）+ 按次回复现组装的行动工具集（发言/反应/两层贴纸——发消息、发贴纸
 * 这些副作用动作都在工具执行时当场发生，不再等最终文本）。自定义函数由
 * 模型以 functionCall part 抛回来，执行后把上一轮模型的整个 content 原样
 * 接回 contents、附上 functionResponse 再续跑（content 里的 thought
 * signature 也要一并带回，缺了会丢思考上下文），直到模型不再要工具或达到
 * 轮数上限。查时间不走工具：当前时间默认拼进每次请求的系统提示词（见
 * 下方），转录行也自带每条消息的发送时间（见 ai/utils/chatTranscript.ts 的
 * formatBufferedMessageLine）。心情同样现查现拼：该群当前抽中的心情由
 * ai/mood.ts 维护，这里只读取，不在这里决定要不要重抽（见
 * rollingMemory.ts 的 pushBufferedMessage 里的
 * recordActivityAndMaybeRerollMood）。
 * @param chatId 群聊 ID，用于取该群当前的心情（见 ai/mood.ts 的
 *   currentMoodInstruction）。
 * @param userContent promptContext.ts 的 buildUserContent 拼好的对话上下文。
 * @param toolset 本轮回复的行动工具集（见 createReplyToolset），工具的执行
 *   副作用（发消息/贴纸/反应）都发生在它内部；toolset.tools 直接透传给
 *   请求，本函数不再自己组装。
 * @returns 模型最后一轮的正文文本（正常情况下模型已通过工具把话说完、正文
 *   为空）；请求失败、超时、被 token 上限腰斩或空输出时返回 null。调用方
 *   只在模型一条消息都没发出去时才把它当兜底回复用。
 */
export async function callGemini(chatId: number, userContent: string, toolset: ReplyToolset): Promise<string | null> {
  // 每次请求现查当前时间拼进系统提示词（而非用模块加载时算好的值），worker
  // 线程常驻、一跑就是几天，缓存的时间会很快过期。
  const systemPrompt: string = `${SYSTEM_PROMPT}\n\n${currentMoodInstruction(chatId)}\n\n${currentTimeSentence()}${TIME_AWARENESS_INSTRUCTION}\n\n${WEB_SEARCH_INSTRUCTION}`;
  const contents: Content[] = [{ role: "user", parts: [{ text: userContent }] }];

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data: GenerateContentResponse | null = await requestGeminiResponse(
      {
        model: GEMINI_REPLY_MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: toolset.tools,
          // 内置 googleSearch 与自定义函数混用同一次请求时 API 硬性要求开
          // 这个开关（不开直接 400）。开了之后服务端工具的执行记录会以
          // toolCall/toolResponse part 的形式混进 content——它们不是
          // functionCall part，extractFunctionCalls 不会误当成待执行的
          // 自定义函数；多轮往返时随整个 content 原样接回即可（实测确认）。
          toolConfig: { includeServerSideToolInvocations: true },
          temperature: REPLY_TEMPERATURE,
          maxOutputTokens: REPLY_MAX_TOKENS,
        },
      },
      "Gemini API"
    );
    if (!data) return null;

    const functionCalls: ExtractedFunctionCall[] = extractFunctionCalls(data);
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
        const result: string = toolset.has(call.name)
          ? await toolset.execute(call.name, JSON.stringify(call.args ?? {}))
          : await callTool(call.name);
        // 工具实现返回的都是 JSON 字符串（见 src/ai/tools），
        // functionResponse.response 要求对象，解析回来直接挂上。
        responseParts.push({ functionResponse: { id: call.id, name: call.name, response: JSON.parse(result) } });
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    // 写到一半被 maxOutputTokens 腰斩的半句话，宁可不要，也不把断掉的句子
    // 当兜底回复发到群里——真人不会发一半句子就没下文，见 ai/gemini.ts 的
    // isTruncatedByTokenLimit。googleSearch 命中时尤其容易撞进这种情况。
    if (isTruncatedByTokenLimit(data)) return null;

    return extractOutputText(data) || null;
  }

  return null;
}
