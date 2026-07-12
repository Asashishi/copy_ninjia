/**
 * AI 闲聊的调参常量。AI_REPLY_PROBABILITY 由主线程（src/auto/message.ts）的触发
 * 调度使用，其余都是 Worker 线程（workers/aiChatWorker.ts）流水线的旋钮。
 */

/**
 * 没有其它触发条件时，普通发言触发一次 AI 回复的概率。掷骰子决定是否触发
 * 属于主线程的调度逻辑（见 src/auto/message.ts），Worker 只执行已触发的回复。
 */
export const AI_REPLY_PROBABILITY: number = 1 / 4;

export const DEEPSEEK_API_URL: string = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL: string = "deepseek-v4-flash";
export const REQUEST_TIMEOUT_MS: number = 60_000;

/** 每个群聊在内存里保留的最近消息条数（Bot API 无法拉历史，只能自己滚动缓存）。 */
export const BUFFER_SIZE: number = 75;
/** 生成回复时，从缓存里取最近多少条作为上下文喂给模型（与 BUFFER_SIZE 相等即整个缓存全喂）。 */
export const CONTEXT_SIZE: number = 75;
/** 触发回复后，采用「连发多条短消息」形式（而非单条）的概率。 */
export const SPLIT_REPLY_PROBABILITY: number = 1 / 3;
/** 连发模式下最多发几条，防止模型话痨刷屏。 */
export const SPLIT_REPLY_MAX_PARTS: number = 5;
/**
 * 同一群聊两次 AI 回复之间的最短间隔。回复机器人 / @ 机器人是 100% 触发且
 * 无上限的，没有这道闸的话，恶意用户循环回复 bot 就能形成「一条消息 = 一次
 * API 调用 + 一条群消息」的刷屏/烧钱放大链。冷却内命中的触发直接静默丢弃。
 */
export const AI_REPLY_COOLDOWN_MS: number = 500;

/**
 * 分群限频：单个群滚动窗口内最多触发多少次 AI 回复。每群冷却只限制相邻
 * 两次的间隔（1.5 秒冷却下一分钟仍可达 40 次），这两道滑动窗口给单群的
 * 总量再兜两层——1 分钟窗口挡住短时爆发，5 分钟窗口再挡住那种卡着 1 分钟
 * 窗口边界反复刷、绕开短窗口上限的持续刷屏。两道闸中任意一道打满，触发
 * 就直接丢弃（黑洞，只回一句带独立冷却的「你们太快了」提示，见下方
 * RATE_LIMIT_NOTICE_COOLDOWN_MS），等对应窗口里旧时刻滑出窗口腾出名额才
 * 恢复，不是硬性定时重置。只在入口计一次数——一次触发内的「连发多条
 * 短消息」属于同一次回复，不重复计数。
 */
export const RATE_LIMIT_WINDOW_MS: number = 60_000;
export const RATE_LIMIT_MAX_TRIGGERS: number = 45;
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;

/**
 * 触发被限频黑洞丢弃时会明确回一句「你们太快了」（见 workers/aiChatWorker.ts 的
 * notifyRateLimited），这是该提示自身的冷却：同一个群在这段时间内至多提示
 * 一次，防止提示本身在刷屏场景下变成新的刷屏放大器。
 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;

/**
 * 判断一条消息是否在问时间/日期。命中时会把真实当前时间直接注入 prompt
 * （见 workers/aiChatWorker.ts 的 UserContentOptions.timeContext），而不是交给模型
 * 自己判断要不要查——auto 模式下模型经常瞎编时间而不调用工具，命中率太低。
 */
export const TIME_INTENT_PATTERN: RegExp =
  /现在几点|几点了|几点钟|现在.{0,4}时间|当前时间|今天.{0,3}[几号日]|几月几[号日]|星期几|周几|报时|what\s*time|current\s*time/i;

/**
 * 一次工具调用往返最多允许几轮（模型要工具结果 -> 喂回去 -> 模型可能再要
 * 下一个工具……）。给个上限防止模型陷入死循环反复要工具，烧穿 API 配额。
 */
export const MAX_TOOL_ROUNDS: number = 3;
