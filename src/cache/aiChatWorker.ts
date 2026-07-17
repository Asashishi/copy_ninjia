import type { LinkedQueue } from "../libs/linkedQueue";
import type { AiBotInfo, BufferedMessage, ChatActionPhase } from "../types";

/**
 * AI 闲聊流水线（src/workers/aiChatWorker.ts）的内存状态。本模块只被 Worker 线程
 * import，所有状态都存活在该线程内；滚动记忆会定期上报主线程落盘，其余
 * 限频、任务链与心跳等运行时状态在 Worker 重启时清空。
 */

/** 机器人自己的账号身份，由主线程 bot.init() 之后经 init 消息注入（见
 *  workers/aiChatWorker.ts 的 self.onmessage "init" 分支）；本 Worker 重建
 *  之前始终为 null。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** 各群聊上一次 AI 回复的触发时刻（毫秒时间戳），用于冷却判断。 */
export const lastReplyTimes: Map<number, number> = new Map();

/** 各群上一次发送「限频黑洞」提示的时刻（毫秒时间戳），给提示自身做冷却。 */
export const rateLimitNoticeTimes: Map<number, number> = new Map();

/** 各群 1 分钟窗口内每次触发的时刻（毫秒时间戳），队首最旧，过期即出队。 */
export const triggerTimes: Map<number, LinkedQueue<number>> = new Map();
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
 * + 压缩新镜像（一次 Gemini 网络调用）。消息洪峰下同一群可能背靠背
 * 轮换两轮，靠把新一轮 then 在上一轮之后，保证晋升的一定是上一轮的结果、
 * 摘要严格按时间顺序入队（链上的任务自身兜错，链永不 reject）。
 */
export const compactionChains: Map<number, Promise<void>> = new Map();
/** 各群压缩任务的执行中 + 排队中数量；完成后归零并删除。 */
export const compactionPendingCounts: Map<number, number> = new Map();

/** 正在生成回复的群。同一群只允许一轮在途，防止旧请求晚到后倒序发言。 */
export const activeReplyChats: Set<number> = new Set();

/** chatId -> 该群当前共享的聊天状态心跳（重发定时器 + 当前挡位 + 全部尚未
 * 完成的状态请求，见 startChatActionHeartbeat）。Set 防止相邻 tick 与即时
 * 切挡互相覆盖引用，settle 才能等齐所有可能晚到的请求。 */
export const typingHeartbeats: Map<number, { timer: ReturnType<typeof setInterval>; refCount: number; action: ChatActionPhase; inflight: Set<Promise<unknown>> }> = new Map();

/**
 * 自上次上报记忆快照后有变更（recordChatMessage/promotePendingSummary/
 * rotateCompaction 三处标记）、待上报给主线程落盘的群，见
 * flushDirtyMemories。上报后清空。
 */
export const dirtyMemoryChats: Set<number> = new Set();
