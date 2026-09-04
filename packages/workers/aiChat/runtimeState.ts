import { currentMoodInstruction } from "../../aiChat/ai/mood";
import {
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
  TIME_AWARENESS_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { MOOD_STATE_PRECEDENCE_INSTRUCTION } from "../../consts/aiChat/prompts/mood";
import { currentTimeSentence } from "./timeSentence";

/**
 * 本轮运行时状态区块：今天的心情与当前实际时间。
 *
 * 这两样**必须待在 user 内容里、不能回到 systemInstruction**。当前时间精确到秒，
 * 心情按随机寿命轮换：把它们拼在系统提示词末尾，就等于让人设、固定指令和工具
 * 声明那一整段稳定前缀跟着每秒变一次，两家供应商的自动前缀缓存都会一路落空。
 * 放在转录之后、回复任务之前，
 * 既排在所有稳定内容后面，又紧挨着它要影响的那段任务。
 *
 * 段落文案与区块标签同 promptContext.ts 的另外三段同源（见
 * consts/aiChat/prompts/memory.ts），防注入总规则只在 systemInstruction 声明一次。
 * 本轮生图参考素材同理住在这里：那段文案带着每次触发都不同的素材尺寸，留在工具声明里
 * 会让整段工具声明每轮换一个指纹（见 aiChat/ai/tools/replyToolset/imageReference.ts）。
 * 没挂生图工具时 imageReference 是空串，本区块因此与不含生图的轮次逐字相同。生图与
 * 生歌的群冷却不写进任何提示词，只由两个执行器在调用时判定。
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
