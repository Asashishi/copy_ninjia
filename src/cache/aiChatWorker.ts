import type { LinkedQueue } from "../linkedQueue";
import type { BufferedMessage } from "../types";

/**
 * AI 闲聊流水线（src/aiChatWorker.ts）的内存状态。本模块只被 Worker 线程
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
