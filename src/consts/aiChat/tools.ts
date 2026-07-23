import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { SafetySetting } from "@google/genai";

/** 闲聊回复模型与所有 Gemini 请求的 per-attempt 超时。 */
export const GEMINI_REPLY_MODEL: string = "gemini-3.5-flash-lite";
/** 单次 Gemini 回复/摘要请求的超时上限。 */
export const GEMINI_REQUEST_TIMEOUT_MS: number = 150_000;
/** 回复 token 上限包含思考 token；温度偏高以保留人设发挥。 */
export const REPLY_MAX_TOKENS: number = 65_536;
/** 闲聊回复生成温度。 */
export const REPLY_TEMPERATURE: number = 1.2;

/**
 * 所有 Gemini 请求统一携带的内容过滤设置；应用不按可调概率等级主动拒绝，
 * 仍受 API 不可关闭的核心安全策略约束。数组与条目均冻结，避免调用方漂移。
 */
export const GEMINI_SAFETY_SETTINGS: readonly SafetySetting[] = Object.freeze([
  Object.freeze({ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE }),
  Object.freeze({ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE }),
  Object.freeze({ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE }),
  Object.freeze({ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }),
]);

/** 告知模型的单轮动作上限；低于执行硬顶，为模型偏离提示留出安全余量。 */
export const AI_MAX_ACTIONS_PER_REPLY: number = 8;
/** 一轮所有可见动作与表情反应的执行侧硬顶。 */
export const HARD_MAX_ACTIONS_PER_REPLY: number = 11;
/** 单轮回复允许执行的表情反应次数。 */
export const MAX_REACTIONS_PER_REPLY: number = 1;
/** 单条消息发送前的模拟输入停顿参数。 */
export const TYPING_DELAY_BASE_MS: number = 1_500;
/** 模拟输入停顿按正文字符数增加的毫秒数。 */
export const TYPING_DELAY_PER_CHAR_MS: number = 55;
/** 模拟输入停顿额外随机抖动的上界。 */
export const TYPING_DELAY_JITTER_MS: number = 400;
/** 单条消息模拟输入停顿的硬上限。 */
export const TYPING_DELAY_MAX_MS: number = 7_500;

/** 工具对话往返硬顶，防止模型工具调用死循环。 */
export const MAX_TOOL_ROUNDS: number = 35;
/** 单轮回复累计允许的 Google Search 服务端调用数；达到后续轮次移除搜索工具。 */
export const MAX_GOOGLE_SEARCH_CALLS_PER_REPLY: number = 3;
/** 所有自定义函数调用（含查询、查看、失败/拒绝调用）的整轮硬顶。 */
export const MAX_CUSTOM_TOOL_CALLS_PER_REPLY: number = 20;
/** 单一函数达到该次数后，从下一请求的 declarations 中移除，阻止重试环。 */
export const MAX_CUSTOM_TOOL_CALLS_PER_NAME: number = 4;
/** Telegram chat action 的心跳间隔与连续失败止损阈值。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;
/** 连续发送 chat action 失败后的止损阈值。 */
export const CHAT_ACTION_MAX_CONSECUTIVE_FAILURES: number = 3;

/** 本轮由代码侧预先决定是否制造一次单字手滑。 */
export const AI_TEXT_TYPO_PROBABILITY: number = 0.15;
/** 采纳一次手滑要求的最少剩余动作预算：错字消息本体之外，还得给可能的
 *  快速补正确单字留一个动作，见
 *  ai/tools/replyToolset/typoHandling.ts 的 decideMessageTypo。 */
export const TYPO_MIN_REMAINING_ACTIONS: number = 2;
/** 出错后补发正确单字的概率；剩余 10% 视为没发现。 */
export const TYPO_QUICK_CORRECTION_PROBABILITY: number = 0.9;
/** 手滑后快速补字停顿的最小值。 */
export const TYPO_QUICK_CORRECTION_MIN_MS: number = 7_500;
/** 手滑后快速补字停顿的最大值。 */
export const TYPO_QUICK_CORRECTION_MAX_MS: number = 10_000;
