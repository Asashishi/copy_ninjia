import { logger, relayLogMessage } from "./logger";
import type { AiBotInfo, AiChatWorkerMessage, AiInitMessage, ForwardedLog } from "./types";

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、冷却与
 * 限频、拼装上下文、调 DeepSeek（含 function calling 往返）、连发消息、
 * 消息反应、贴纸跟发——全部在独立的 Bun Worker（src/aiChatWorker.ts）里
 * 执行；主线程只把「记录一条群消息」「触发一次回复」两类事件投递过去，
 * 让 /命令 处理与更新调度不被 AI 流水线抢占。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 */

// Worker 崩溃自愈的节流，逻辑与 logger.ts 的落盘 Worker 一致：短时间内
// 反复崩溃就放弃自愈（多半是代码本身有 bug，重启也没用），只是安静地
// 丢弃后续消息，不让 AI 闲聊功能的崩溃循环拖累主线程；崩溃很稀疏则每次
// 都正常重启。
const MAX_RESTARTS: number = 5;
const RESTART_WINDOW_MS: number = 60_000;
let restartTimestamps: number[] = [];

// 重启后新 Worker 不知道机器人自己的账号身份，需要重放最近一次 init 消息
// （见 initAiChat）；重启发生在 initAiChat 调用之前的话就没有可重放的，
// 新 Worker 等本来就该来的那次 initAiChat 调用即可。
let lastInit: AiInitMessage | null = null;

// Worker 在模块加载时启动一次。unref 让它不阻止进程退出——停机时在途的
// AI 回复任务随之丢弃，与旧实现（主线程里 fire-and-forget 的 promise 随
// 进程退出丢弃）行为一致。为 null 代表自愈已放弃（见 onerror 里的兜底
// 分支），post() 此时安静地丢弃消息，不能再对着一个已终止的 Worker
// postMessage——Bun 对已终止的 Worker 调用 postMessage 会同步抛
// InvalidStateError，recordChatMessage 又是每条群消息都会调用一次，不
// 判空的话放弃自愈后反而变成每条消息都抛未捕获异常。
let worker: Worker | null = createWorker();

function createWorker(): Worker {
  const w: Worker = new Worker(new URL("./workers/aiChatWorker.ts", import.meta.url).href);
  w.unref();
  // Worker 线程里的 logger 处于转发模式（见 logger.ts 模块头注释）：error
  // 日志包着 ForwardedLog 信封回传，这里转投主线程唯一的落盘线程。
  w.onmessage = (event: MessageEvent<ForwardedLog>) => {
    if (event.data && typeof event.data === "object" && "__log" in event.data) {
      relayLogMessage(event.data.__log);
    }
  };
  w.onerror = (event: ErrorEvent) => {
    logger.error("AI Worker 出错，准备重启：", event.message || event.error || event);
    // Bun 里 Worker 内部一旦抛出未捕获异常（同步或 async 均如此，已实测
    // 验证）就会直接终止该 Worker 线程，因此这里不需要（实际上也没法）
    // 再手动 terminate，直接换一个新实例顶上即可。
    const now: number = Date.now();
    restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
    if (restartTimestamps.length >= MAX_RESTARTS) {
      logger.error(
        `AI Worker 在 ${RESTART_WINDOW_MS / 1000} 秒内已重启 ${MAX_RESTARTS} 次，放弃自愈——` +
        `AI 闲聊功能此后静默失效，直到进程重启。`
      );
      worker = null;
      return;
    }
    restartTimestamps.push(now);
    const next: Worker = createWorker();
    worker = next;
    // 新 Worker 重新走一遍身份注入，FIFO 保证它先于任何 record/trigger 到达。
    if (lastInit) {
      next.postMessage(lastInit);
    }
  };
  return w;
}

function post(message: AiChatWorkerMessage): void {
  worker?.postMessage(message);
}

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
