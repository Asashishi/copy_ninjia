import { relayLogMessage } from "./logger";
import type { AiBotInfo, AiChatWorkerMessage, ForwardedLog } from "./types";

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、冷却与
 * 限频、拼装上下文、调 DeepSeek（含 function calling 往返）、连发消息、
 * 消息反应、贴纸跟发——全部在独立的 Bun Worker（src/aiChatWorker.ts）里
 * 执行；主线程只把「记录一条群消息」「触发一次回复」两类事件投递过去，
 * 让 /命令 处理与更新调度不被 AI 流水线抢占。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 */

// Worker 在模块加载时启动一次。unref 让它不阻止进程退出——停机时在途的
// AI 回复任务随之丢弃，与旧实现（主线程里 fire-and-forget 的 promise 随
// 进程退出丢弃）行为一致。
const worker: Worker = new Worker(new URL("./aiChatWorker.ts", import.meta.url).href);
worker.unref();

// Worker 线程里的 logger 处于转发模式（见 logger.ts 模块头注释）：error
// 日志包着 ForwardedLog 信封回传，这里转投主线程唯一的落盘线程。
worker.onmessage = (event: MessageEvent<ForwardedLog>) => {
  if (event.data && typeof event.data === "object" && "__log" in event.data) {
    relayLogMessage(event.data.__log);
  }
};

function post(message: AiChatWorkerMessage): void {
  worker.postMessage(message);
}

/**
 * 把机器人自己的账号身份注入 AI Worker。须在 bot.init() 之后、runner 开始
 * 投喂更新之前调用一次（见 index.ts）——FIFO 保证 init 消息先于一切
 * record/trigger 到达。Worker 靠它在转录里认出自己并自录自己发的消息。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  post({ type: "init", botInfo: { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name } });
}

/**
 * 记录一条群消息到该群在 Worker 侧的滚动缓存，供之后拼装成对话上下文喂给
 * 模型。文本与昵称在 Worker 侧会被压成单行（防转录注入）。
 * @param chatId 群聊 ID。
 * @param id 发言人 id（真实用户 id，或频道马甲/频道帖的频道 id）。
 * @param firstName 发言人 first_name（频道则是 title）。
 * @param lastName 发言人 last_name（频道则为空）。
 * @param text 消息文本。
 */
export function recordChatMessage(chatId: number, id: number, firstName: string, lastName: string, text: string): void {
  post({ type: "record", chatId, senderId: id, firstName, lastName, text });
}

/**
 * 触发一次 AI 回复：把触发事件投递给 Worker，由它做冷却/限频判定并执行
 * 完整的生成与发送流程。fire-and-forget，主线程不等待任何结果。
 * @param chatId 目标群聊。
 * @param replyToMessageId 触发这次回复的消息 ID，回复/@ 触发时用它引用原消息。
 * @param repliedBotText 若是「用户回复机器人」触发，被回复的机器人消息文本。
 * @param isRandomTrigger 是否是无人回复/@机器人、单纯按概率命中的随机搭话
 *   （这种情况不挂 Telegram 回复引用，改为让模型在文字里点名称呼触发者）。
 */
export function generateAndSendReply(
  chatId: number,
  replyToMessageId: number,
  repliedBotText?: string,
  isRandomTrigger: boolean = false
): void {
  post({ type: "trigger", chatId, replyToMessageId, repliedBotText, isRandomTrigger });
}
