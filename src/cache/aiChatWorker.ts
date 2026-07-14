import type { LinkedQueue } from "../libs/linkedQueue";
import type { BufferedMessage } from "../types";

/**
 * AI 闲聊流水线（src/workers/aiChatWorker.ts）的内存状态。本模块只被 Worker 线程
 * import，所有状态都存活在该线程内；仅存于内存，重启即清空（本功能不做
 * 持久记忆）。
 */

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
 * + 压缩新镜像（一次 DeepSeek 网络调用）。消息洪峰下同一群可能背靠背
 * 轮换两轮，靠把新一轮 then 在上一轮之后，保证晋升的一定是上一轮的结果、
 * 摘要严格按时间顺序入队（链上的任务自身兜错，链永不 reject）。
 */
export const compactionChains: Map<number, Promise<void>> = new Map();

/** chatId -> 该群当前共享的「正在输入…」重发定时器（见 startTypingHeartbeat）。 */
export const typingHeartbeats: Map<number, { timer: ReturnType<typeof setInterval>; refCount: number }> = new Map();
