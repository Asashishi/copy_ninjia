import { currentMoodInstruction } from "../../aiChat/ai/mood";
import {
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
  TIME_AWARENESS_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import { currentTimeSentence } from "./timeSentence";

/**
 * 本轮运行时状态区块：今天的心情、当前实际时间与本轮工具状态，拼在转录之后、回复
 * 任务之前。
 *
 * 心情、时间与工具状态必须待在 user 内容里、不能回到 systemInstruction 或工具声明；
 * 提示词稳定前缀与动态内容的顺序约束见 docs/cn/04-invariants.md「AI 提示词与转录」。
 *
 * 区块标签与段落文案同 promptContext.ts 的另外三段同源（见
 * consts/aiChat/prompts/memory.ts），防注入总规则只在 systemInstruction 声明一次。
 * 本区块只写事实：据工具状态怎么做由系统提示词「行动与停止」段（ReplyToolset.replyActionInstruction）规定。
 *
 * 心情全 Worker 共用一份，读取时顺带处理到期重抽（见 aiChat/ai/mood.ts）。
 *
 * @param toolStatus createReplyToolset 取好的本轮工具状态段（见
 *   aiChat/ai/tools/replyToolset/toolStatus.ts）。
 */
export function buildRuntimeStateBlock(toolStatus: string): string {
  return `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.runtimeState.header +
    "\n" +
    MOOD_STATE_PRECEDENCE_INSTRUCTION +
    "\n" +
    currentMoodInstruction() +
    "\n" +
    currentTimeSentence() +
    TIME_AWARENESS_INSTRUCTION +
    "\n" +
    toolStatus +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.runtimeState}]`;
}
