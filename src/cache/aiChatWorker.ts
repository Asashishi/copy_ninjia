import type { LinkedQueue } from "../libs/linkedQueue";
import { LruCache } from "../libs/lruCache";
import { REPLY_GENERATIONS_MAX } from "../consts/aiChat";
import type { AiBotInfo, BufferedMessage, ChatActionHeartbeatEntry, MoodOption, QueuedReplyTrigger } from "../types";

/**
 * AI 闲聊流水线（src/workers/aiChatWorker.ts）的内存状态。本模块只被 Worker 线程
 * import，所有状态都存活在该线程内；滚动记忆会定期上报主线程落盘，其余
 * 限频、任务链与心跳等运行时状态在 Worker 重启时清空。
 */

/** 机器人自己的账号身份，由主线程 bot.init() 之后经 init 消息注入（见
 *  workers/aiChatWorker.ts 的 self.onmessage "init" 分支）；本 Worker 重建
 *  之前始终为 null。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** 禁用/淘汰时递增；在途回复只允许在捕获的代数仍为当前值时产生新副作用。
 *  刻意排除在 purgeChatMemory 之外——被淘汰的群不能复用旧的低代际。用
 *  LruCache（读取即刷新热度）而非普通 Map 装它，防止随进程存活时间单调
 *  增长，见 consts/aiChat.ts 的 REPLY_GENERATIONS_MAX 注释。 */
export const replyGenerations: LruCache<number, number> = new LruCache(REPLY_GENERATIONS_MAX);

/** 各群上一次发送「限频黑洞」提示的时刻（毫秒时间戳），给提示自身做冷却。 */
export const rateLimitNoticeTimes: Map<number, number> = new Map();

/** 各群 5 分钟窗口内每次触发的时刻（毫秒时间戳），队首最旧，过期即出队。 */
export const longTriggerTimes: Map<number, LinkedQueue<number>> = new Map();

/** 各群聊各自的滚动消息缓存（Bot API 无法拉历史，只能边收边攒）。 */
export const chatBuffers: Map<number, LinkedQueue<BufferedMessage>> = new Map();

/**
 * 各群的中期记忆：滑出逐字区的冷消息按每 50 条一轮被 AI 压缩成摘要，
 * 存在这里（队首最旧），最多保留 MAX_SUMMARY_ROUNDS 轮，超出滑动移除。
 * 拼装回复上下文时整队摘要会作为背景段落喂给模型。
 */
export const chatSummaries: Map<number, LinkedQueue<string>> = new Map();

/**
 * 各群「待晋升」的镜像摘要：镜像块的 AI 压缩结果先存这里，等该块滑出
 * 逐字区（下一轮轮换）才晋升进 chatSummaries——镜像原文还在上下文里时，
 * 它的摘要不重复喂给模型。压缩失败则本轮无待晋升项，晋升时该段记忆缺失。
 */
export const pendingSummaries: Map<number, string> = new Map();

/**
 * 各群轮换任务的串行链（尾部 promise）。每轮任务 = 晋升上一轮镜像的摘要
 * + 压缩新镜像（一到几次 Gemini 网络调用，失败退避重试，见
 * consts/aiChat.ts 的 SUMMARY_RETRY_DELAYS_MS）。消息洪峰下同一群可能背靠背
 * 轮换两轮，靠把新一轮 then 在上一轮之后，保证晋升的一定是上一轮的结果、
 * 摘要严格按时间顺序入队（链上的任务自身兜错，链永不 reject）。
 */
export const compactionChains: Map<number, Promise<void>> = new Map();
/** 各群压缩任务的执行中 + 排队中数量；完成后归零并删除。 */
export const compactionPendingCounts: Map<number, number> = new Map();

/** 各群在途回复轮数（无在途即无键）。同群最多 REPLY_ROUND_MAX_CONCURRENT
 *  轮工具对话并发；并发轮之间发言可能互相穿插乱序，是不让真人干等换来的
 *  有意权衡（见 consts/aiChat.ts 该常量注释）。 */
export const activeReplyCounts: Map<number, number> = new Map();

/** 各群排队等待补跑的直接触发（回复/@，队首最旧）。并发闸打满期间这类
 *  交互不丢弃，攒在这里等某轮结束腾出空位后先来后到逐个补跑（见
 *  workers/aiChat/replyQueue.ts 的 drainReplyQueue）；上限
 *  REPLY_TRIGGER_QUEUE_MAX，打满才丢。队列随 Worker 重启清空。 */
export const pendingReplyTriggers: Map<number, LinkedQueue<QueuedReplyTrigger>> = new Map();

/** 等候队列打满、欠着一句「你们太快了」提示的群。溢出只会发生在并发位
 *  占满期间，提示压到某轮结束腾出空位时再发（见 drainReplyQueue），至少
 *  不打断刚收尾那轮自己连发的短句。 */
export const pendingOverflowNotices: Set<number> = new Set();

/** chatId -> 该群当前共享的聊天状态心跳（重发定时器 + 当前挡位 + 全部尚未
 * 完成的状态请求，见 ai/chatActionHeartbeat.ts）。Set 防止相邻 tick 与即时
 * 切挡互相覆盖引用，发送前 settle 才能等齐所有可能晚到的请求。 */
export const typingHeartbeats: Map<number, ChatActionHeartbeatEntry> = new Map();

/** chatId -> 该群当前持有「发贴纸锁」的回复轮令牌（无持有者即无键）。同群
 *  多轮并发时只有抢到锁的那轮能发贴纸，其余轮的 send_sticker 被拒绝、改用
 *  文字回应；持锁轮结束时释放（见 ai/stickerSendLock.ts 与
 *  workers/aiChat/replyRound.ts 的 startReplyRound）。 */
export const stickerSendLocks: Map<number, object> = new Map();

/**
 * 自上次上报记忆快照后有变更（recordChatMessage/promotePendingSummary/
 * rotateCompaction 三处标记）、待上报给主线程落盘的群，见
 * flushDirtyMemories。上报后清空。
 */
export const dirtyMemoryChats: Set<number> = new Set();

/** 各群当前抽中的心情（本群还没抽过则无键）；随每次「有动静」按空窗
 *  阈值随机重抽，见 ai/mood.ts 的 recordActivityAndMaybeRerollMood。不落盘，
 *  随 Worker 重启清空。 */
export const chatMoods: Map<number, MoodOption> = new Map();

/** 各群最后一次有消息动静的时刻（毫秒时间戳），只用于心情重抽的空窗判定
 *  （见 ai/mood.ts），与 BufferedMessage.at 的展示用时间字符串无关。不落盘，
 *  随 Worker 重启清空。 */
export const chatLastActivityTimes: Map<number, number> = new Map();
