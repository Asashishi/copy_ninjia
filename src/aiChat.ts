import { superviseWorker } from "./libs/supervisedWorker";
import { markSelfSent } from "./infra/selfSentTracker";
import { onDiskIORespawn, postDiskIO } from "./infra/diskIO";
import type { AiBotInfo, AiChatWorkerEvent, AiChatWorkerMessage, AiInitMessage, AiMemorySnapshot } from "./types";

/**
 * AI 闲聊入口（主线程侧代理）。真正的回复流水线——滚动对话缓存、图片
 * 占位与异步描述、冷却与限频、拼装上下文、调 Grok（含 function calling
 * 往返与内置 web_search）、连发消息、
 * 消息反应、贴纸跟发——全部在独立的 Bun Worker（src/workers/aiChatWorker.ts）里
 * 执行；主线程只把「记录一条群消息」「触发一次回复」两类事件投递过去，
 * 让 /命令 处理与更新调度不被 AI 流水线抢占。postMessage 按 FIFO 送达，
 * 同一群里「先记录、后触发」的先后顺序在 Worker 侧保持不变。
 *
 * Worker 的启动、崩溃自愈（含节流放弃）、日志转投见 libs/supervisedWorker.ts。
 *
 * AI 记忆持久化：aiChatWorker 定期把各群 dirty 的记忆快照（滚动缓存 + 中期
 * 摘要）上报到这里（memory 事件），本模块存一份镜像（latestAiMemories）后
 * 转投 diskIOWorker 落盘。这份镜像同时是双向崩溃重放的唯一来源：aiChatWorker
 * 崩溃重启后凭它重放 hydrate（下方 onRespawn），diskIOWorker 崩溃重启后
 * 凭它重发落盘（下方 onDiskIORespawn），两条路径互不依赖。
 */

// 重启后新 Worker 不知道机器人自己的账号身份，需要重放最近一次 init 消息
// （见 initAiChat）；重启发生在 initAiChat 调用之前的话就没有可重放的，
// 新 Worker 等本来就该来的那次 initAiChat 调用即可。
let lastInit: AiInitMessage | null = null;

/** 各群最新的 AI 记忆快照镜像，见上方模块头注「AI 记忆持久化」。 */
const latestAiMemories: Map<number, AiMemorySnapshot> = new Map();

/** flushAiMemory 的回执路由：flushId -> resolve（握手样式同 infra/diskIO.ts 的 pendingFlushes）。 */
const pendingMemoryFlushes: Map<number, () => void> = new Map();

const { post } = superviseWorker<AiChatWorkerMessage, AiChatWorkerEvent>({
  url: new URL("./workers/aiChatWorker.ts", import.meta.url).href,
  label: "AI Worker",
  giveUpConsequence: "AI chat feature will silently stay disabled until the process restarts.",
  onEvent: (event) => {
    switch (event.type) {
      case "sent":
        // Worker 报回它刚发出的消息：登记进自发消息表，供自动流水线识别
        // 频道自回环（见 infra/selfSentTracker.ts）。
        markSelfSent(event.chatId, event.messageId);
        break;
      case "memory":
        latestAiMemories.set(event.chatId, event.snapshot);
        postDiskIO({ type: "aiMemory", chatId: event.chatId, snapshot: event.snapshot });
        break;
      case "memoryFlushed": {
        const resolve = pendingMemoryFlushes.get(event.flushId);
        if (resolve) {
          pendingMemoryFlushes.delete(event.flushId);
          resolve();
        }
        break;
      }
    }
  },
  onRespawn: (postToNext) => {
    // 新 Worker 重新走一遍身份注入，FIFO 保证它先于任何 record/trigger 到达。
    if (lastInit) postToNext(lastInit);
    // 记忆镜像同样要重放：新 Worker 内存全空，凭上一实例上报过的最新快照
    // 补齐（见模块头注）。
    if (latestAiMemories.size > 0) {
      postToNext({ type: "hydrate", memories: latestAiMemories });
    }
  },
});

// diskIOWorker 崩溃重建后，把当前记忆镜像整份重发给它，补齐上一次成功
// 落盘之后的增量（见 infra/diskIO.ts 的 onDiskIORespawn 注释）。
onDiskIORespawn(() => {
  for (const [chatId, snapshot] of latestAiMemories) {
    postDiskIO({ type: "aiMemory", chatId, snapshot });
  }
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
 * 启动时把 diskIOWorker 落盘恢复出的 AI 记忆快照灌回来：先存一份镜像
 * （供后续崩溃重放，见模块头注），再投递给 Worker 做 hydrate。必须在
 * initAiChat 之后、runner 开始投喂更新之前调用（见 index.ts），FIFO 保证
 * hydrate 消息先于一切 record/trigger 到达。
 */
export function hydrateAiMemory(memories: Map<number, AiMemorySnapshot>): void {
  for (const [chatId, snapshot] of memories) {
    latestAiMemories.set(chatId, snapshot);
  }
  if (memories.size > 0) {
    post({ type: "hydrate", memories });
  }
}

let nextMemoryFlushId: number = 1;

/**
 * 要求 aiChatWorker 立即把所有 dirty 群的记忆快照上报（进而转投 diskIOWorker
 * 落盘），并等待完成。用于进程退出前的最后一刷（握手样式同 infra/diskIO.ts
 * 的 flushDiskIO）。带超时兜底：Worker 异常时停机流程最多被拖住 timeoutMs，
 * 不会挂死。
 */
export function flushAiMemory(timeoutMs: number = 2000): Promise<void> {
  return new Promise((resolve) => {
    const id: number = nextMemoryFlushId++;
    const timer = setTimeout(() => {
      pendingMemoryFlushes.delete(id);
      resolve();
    }, timeoutMs);
    pendingMemoryFlushes.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    post({ type: "flushMemory", flushId: id });
  });
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
 * 记录一条图片消息：Worker 侧先以占位文本入缓存、异步解析图片后原位回填
 * 描述（见 workers/aiChatWorker.ts 的 recordChatImage）。只记上下文，不触发
 * 回复——与贴纸的处理定位一致。
 * @param caption 图片自带的配文（没有则传空串）。
 * @param fileId 已挑好尺寸档位的 photo file_id。
 */
export function recordChatImage(chatId: number, id: number, firstName: string, lastName: string, caption: string, fileId: string): void {
  post({ type: "recordImage", chatId, senderId: id, firstName, lastName, caption, fileId });
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
