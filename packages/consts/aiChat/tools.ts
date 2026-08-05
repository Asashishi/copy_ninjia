/**
 * AI 闲聊回复流水线里与供应商无关的预算：工具轮数、动作上限、检索额度、
 * 模拟输入停顿与手滑概率。换供应商时这些数不该跟着动。
 *
 * 采样温度与输出 token 上限**不在**这里：那两样由模型能力决定，两家取值并不
 * 通用，各自放在 consts/aiChat/{gemini,openai}.ts；模型名、超时、重试与内容
 * 过滤档位同理。留在本文件的都是「换谁都成立」的领域策略。
 */

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
/** 单轮回复累计允许的服务端联网检索调用数；达到后续轮次移除检索工具。
 *  两家供应商的检索工具真名不同，预算口径与提示词称呼都保持中立，见
 *  consts/aiChat/prompts/search.ts 的 WEB_SEARCH_TOOL_LABEL。 */
export const MAX_WEB_SEARCH_CALLS_PER_REPLY: number = 5;
/** 所有自定义函数调用（含查询、查看、失败/拒绝调用）的整轮硬顶。 */
export const MAX_CUSTOM_TOOL_CALLS_PER_REPLY: number = 25;
/** Telegram chat action 的心跳间隔与连续失败止损阈值。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;
/** 连续发送 chat action 失败后的止损阈值。 */
export const CHAT_ACTION_MAX_CONSECUTIVE_FAILURES: number = 3;

/** 本轮由代码侧预先决定是否制造一次单字手滑。 */
export const AI_TEXT_TYPO_PROBABILITY: number = 0.15;
/** 采纳一次手滑要求的最少剩余动作预算：错字消息本体之外，还得给可能的
 *  快速补正确单字留一个动作，见
 *  aiChat/ai/tools/replyToolset/typoHandling.ts 的 decideMessageTypo。 */
export const TYPO_MIN_REMAINING_ACTIONS: number = 2;
/**
 * 超长图注改用独立文本消息补发时要求的最少剩余动作预算：图片本体之外还得给
 * 那条文本留一个动作。
 *
 * 口径与 TYPO_MIN_REMAINING_ACTIONS 相同，理由也相同——编排器的门禁只判断
 * 「还有没有额度开始这次调用」，一次返回 actions_used: 2 的调用若不在执行侧
 * 自己按剩余预算收敛，就会把整轮顶过 HARD_MAX_ACTIONS_PER_REPLY，而那个数正是
 * 工具错误文案对模型承诺的硬顶。预算不够时宁可丢掉图注也要把图发出去：图才是
 * 这次调用的主体，整条拒掉等于连图一起丢。
 * 所属模块：aiChat/ai/tools/replyToolset/imageGeneration.ts。
 */
export const IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS: number = 2;
/** 出错后补发正确单字的概率；剩余 10% 视为没发现。 */
export const TYPO_QUICK_CORRECTION_PROBABILITY: number = 0.9;
/** 手滑后快速补字停顿的最小值。 */
export const TYPO_QUICK_CORRECTION_MIN_MS: number = 1_500;
/** 手滑后快速补字停顿的最大值。 */
export const TYPO_QUICK_CORRECTION_MAX_MS: number = 7_500;
