import { currentMoodInstruction } from "../../aiChat/ai/mood";
import {
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
  TIME_AWARENESS_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import { currentTimeSentence } from "./timeSentence";

/**
 * 本轮运行时状态区块：今天的心情与当前实际时间，拼在转录之后、回复任务之前。
 *
 * 心情与时间必须待在 user 内容里、不能回到 systemInstruction；提示词稳定前缀与
 * 动态内容的顺序约束见 docs/cn/04-invariants.md「AI 提示词与转录」。
 *
 * 区块标签与段落文案同 promptContext.ts 的另外三段同源（见
 * consts/aiChat/prompts/memory.ts），防注入总规则只在 systemInstruction 声明一次。
 * imageReference 是本轮生图参考素材文案，没挂生图工具时为空串，此时本区块与不含
 * 生图的轮次逐字相同；生图的群冷却由执行器在调用时判定，不写入提示词。
 *
 * @param chatId 群聊 ID；心情按群维护，读取时顺带处理到期重抽（见 aiChat/ai/mood.ts）。
 * @param imageReference createReplyToolset 取好的生图参考素材文案；没挂生图工具时为空串。
 */
export function buildRuntimeStateBlock(chatId: number, imageReference: string): string {
  return `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.runtimeState.header +
    "\n" +
    MOOD_STATE_PRECEDENCE_INSTRUCTION +
    "\n" +
    currentMoodInstruction(chatId) +
    "\n" +
    currentTimeSentence() +
    TIME_AWARENESS_INSTRUCTION +
    imageReference +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]`;
}
