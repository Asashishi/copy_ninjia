/** 闲聊回复模型与所有 Gemini 请求的 per-attempt 超时。 */
export const GEMINI_REPLY_MODEL: string = "gemini-3.1-flash-lite";
export const GEMINI_REQUEST_TIMEOUT_MS: number = 150_000;
/** 回复 token 上限包含思考 token；温度偏高以保留人设发挥。 */
export const REPLY_MAX_TOKENS: number = 65_536;
export const REPLY_TEMPERATURE: number = 1.0;

/** 一轮所有可见动作与表情反应的执行侧硬顶。 */
export const MAX_ACTIONS_PER_REPLY: number = 8;
export const MAX_REACTIONS_PER_REPLY: number = 1;
/** 单条消息发送前的模拟输入停顿参数。 */
export const TYPING_DELAY_BASE_MS: number = 1_500;
export const TYPING_DELAY_PER_CHAR_MS: number = 55;
export const TYPING_DELAY_JITTER_MS: number = 400;
export const TYPING_DELAY_MAX_MS: number = 7_500;

/** 工具对话往返硬顶，防止模型工具调用死循环。 */
export const MAX_TOOL_ROUNDS: number = 45;
/** Telegram chat action 的心跳间隔与连续失败止损阈值。 */
export const TYPING_ACTION_INTERVAL_MS: number = 4_000;
export const CHAT_ACTION_MAX_CONSECUTIVE_FAILURES: number = 3;

/** 本轮由代码侧预先决定是否制造一次单字手滑。 */
export const AI_TEXT_TYPO_PROBABILITY: number = 0.15;
/** 采纳一次手滑要求的最少剩余动作预算：错字消息本体之外，还得给后续的
 *  纠正动作（快速补字一条，或撤回后重发一条）留出余量，见
 *  ai/tools/replyToolset/typoHandling.ts 的 decideMessageTypo。 */
export const TYPO_MIN_REMAINING_ACTIONS: number = 3;
/** 出错后快速补字 / 撤回重发的概率，剩余概率为不纠正。 */
export const TYPO_QUICK_CORRECTION_PROBABILITY: number = 0.57;
export const TYPO_RECALL_CORRECTION_PROBABILITY: number = 0.33;
export const TYPO_QUICK_CORRECTION_MIN_MS: number = 5_000;
export const TYPO_QUICK_CORRECTION_MAX_MS: number = 7_500;
export const TYPO_RECALL_DELETE_MIN_MS: number = 15_000;
export const TYPO_RECALL_DELETE_MAX_MS: number = 25_000;
