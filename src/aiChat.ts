import { superviseWorker } from "./libs/supervisedWorker";
import { markSelfSent } from "./infra/selfSentTracker";
import type { AiBotInfo, AiChatWorkerEvent, AiChatWorkerMessage, AiInitMessage } from "./types";

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、冷却与
 * 限频、拼装上下文、调 DeepSeek（含 function calling 往返）、连发消息、
 * 消息反应、贴纸跟发——全部在独立的 Bun Worker（src/workers/aiChatWorker.ts）里
 * 执行；主线程只把「记录一条群消息」「触发一次回复」两类事件投递过去，
 * 让 /命令 处理与更新调度不被 AI 流水线抢占。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 */

// 重启后新 Worker 不知道机器人自己的账号身份，需要重放最近一次 init 消息
// （见 initAiChat）；重启发生在 initAiChat 调用之前的话就没有可重放的，
// 新 Worker 等本来就该来的那次 initAiChat 调用即可。
let lastInit: AiInitMessage | null = null;

const { post } = superviseWorker<AiChatWorkerMessage, AiChatWorkerEvent>({
  url: new URL("./workers/aiChatWorker.ts", import.meta.url).href,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  // Worker 报回它刚发出的消息：登记进自发消息表，供自动流水线识别频道
  // 自回环（见 infra/selfSentTracker.ts）。
  onEvent: (event) => {
    switch (event.type) {
      case "sent":
        markSelfSent(event.chatId, event.messageId);
        break;
    }
  },
  // 新 Worker 重新走一遍身份注入，FIFO 保证它先于任何 record/trigger 到达。
  onRespawn: (postToNext) => {
    if (lastInit) postToNext(lastInit);
  },
});

/**
 * 把机器人自己的账号身份注入 AI Worker。须在 bot.init() 之后、runner 开始
 * 投喂更新之前调用一次（见 index.ts）——FIFO 保证 init 消息先于一切
 * record/trigger 到达。Worker 靠它在转录里认出自己并自录自己发的消息。
 * 顺带记一份 lastInit：Worker 崩溃重启后要重放这条消息，新 Worker 才能
 * 重新认出自己。
 */
export function initAiChat(botInfo: AiBotInfo): void {
  const message: AiInitMessage = {
    type: "init",
    botInfo: { id: botInfo.id, username: botInfo.username, first_name: botInfo.first_name },
  };
  lastInit = message;
  post(message);
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
