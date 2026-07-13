/**
 * AI 闲聊的调参常量。AI_REPLY_PROBABILITY 由主线程（src/auto/message.ts）的触发
 * 调度使用，其余都是 Worker 线程（workers/aiChatWorker.ts）流水线的旋钮。
 */

/**
 * 没有其它触发条件时，普通发言触发一次 AI 回复的概率。掷骰子决定是否触发
 * 属于主线程的调度逻辑（见 src/auto/message.ts），Worker 只执行已触发的回复。
 */
export const AI_REPLY_PROBABILITY: number = 1 / 5;

export const DEEPSEEK_API_URL: string = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL: string = "deepseek-v4-pro";
export const REQUEST_TIMEOUT_MS: number = 60_000;

/**
 * 压缩块大小 = 热窗口大小 = 镜像窗口大小。逐字缓存由两个块组成：「热」是
 * 正在累积的最新一块，「镜像」是上一轮攒满时已提交 AI 压缩的那一块——
 * 镜像在自己的摘要生成期间仍整块留在逐字上下文里，等下一块攒满轮换时才
 * 滑出、由（多半早已就绪的）摘要接棒。因此正常情况下不存在「已滑出逐字
 * 区但摘要未就绪」的失忆窗口；例外只有两种：50 条消息的洪峰比一次压缩
 * 调用还快，或压缩失败（刻意不回灌，该段记忆缺失，见
 * workers/aiChatWorker.ts 的 rotateCompaction）。
 * （Bot API 无法拉历史，缓存只能边收边攒。）
 */
export const COMPACT_BATCH_SIZE: number = 50;
/** 逐字上下文的上限：镜像 50 + 热 50。实际在 50 ~ 100 条之间浮动。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/**
 * 每群最多保留几轮压缩摘要，新一轮晋升时超出就滑动移除最旧一轮。
 * 4 轮 × 每轮 50 条 = 相当于 200 条冷历史的中期记忆；加上逐字区的
 * 50 ~ 100 条，模型可感知的对话跨度约 250 ~ 300 条。
 */
export const MAX_SUMMARY_ROUNDS: number = 4;
/** 单条摘要的硬性长度上限（字符），防摘要模型话痨撑爆回复上下文。 */
export const SUMMARY_MAX_CHARS: number = 600;
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
