import {
  aiMemoryRevisionCounters,
  latestAiMemories,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
} from "../cache/main/aiChat";
import type {
  AiRecordMediaMessage,
  AiRecordMessage,
  AiTriggerMessage,
} from "../types/aiChat/protocol";
import {
  AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER,
  AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER,
} from "../consts/aiChat/provider";
import { getChatQa } from "../infra/qaStore";
import { telegramOutboundStats } from "../infra/telegram/outboundGate";
import { postAiChatOrThrow } from "./workerBridge";

/** 为 purge 后第一份新记忆武装即时持久化标志，并在投递失败时回滚新标志。 */
function postMemoryRecord(message: AiRecordMessage | AiRecordMediaMessage): void {
  const armedRevision: number | null | undefined =
    postPurgeAiMemoryPersistRevisions.get(message.chatId);
  const wasArmed: boolean = postPurgeAiMemoryPersistRevisions.has(message.chatId);
  const shouldArm: boolean = !wasArmed &&
    !latestAiMemories.has(message.chatId) &&
    aiMemoryRevisionCounters.has(message.chatId);
  if (shouldArm) postPurgeAiMemoryPersistRevisions.set(message.chatId, null);
  try {
    // 只改已存在字段的值，不新增键：载荷在构造点已按协议顺序写全（含
    // persistImmediately: false），这里补一个键会把它换成另一个隐藏类。
    if (shouldArm || armedRevision === null) message.persistImmediately = true;
    postAiChatOrThrow(message);
  } catch (error: unknown) {
    if (shouldArm) postPurgeAiMemoryPersistRevisions.delete(message.chatId);
    throw error;
  }
}

/**
 * 记录一条群消息到 Worker 侧滚动上下文；主线程只负责保持 FIFO 投递顺序。
 *
 * 入参就是最终载荷，本函数不再 `{type, ...message}` 补一次型别——那次展开
 * 是纯粹的属性重拷贝，且会把调用点刚定好的形状再洗一遍。载荷由
 * auto/message/recordContext.ts 与 aiChat/ai/utils/selfRecord.ts 一次成型。
 *
 * **调用即交出所有权：** 少了那次拷贝之后，postMemoryRecord 的
 * `persistImmediately` 置位改的就是调用方那个对象本身。生产上每个调用点都用
 * builder 现造一份再传进来，天然不共享；但不要把同一个载荷对象攒起来投第二次
 * ——上一次投递可能已经把它的即时持久化标志置上了，第二条会跟着白走一次
 * durable 落盘。
 */
export function recordChatMessage(message: AiRecordMessage): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord(message);
}

/** 记录一条图片、贴纸或 GIF；媒体解析与可选评价都由 AI Worker 完成。 */
export function recordChatMedia(message: AiRecordMediaMessage): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord(message);
}

/** 触发一次回复所需的主线程载荷；随机触发默认关闭。 */
export type GenerateAndSendReplyParams = Omit<
  AiTriggerMessage,
  "type" | "isRandomTrigger" | "telegramBackpressured"
> & {
  isRandomTrigger?: boolean;
};

/** 把一次回复触发投给 Worker；生成、工具调用和发送均不阻塞主线程。 */
export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger = false,
  messageThreadId,
}: GenerateAndSendReplyParams): void {
  const telegramStats: ReturnType<typeof telegramOutboundStats> = telegramOutboundStats();
  postAiChatOrThrow({
    type: "trigger",
    chatId,
    triggerSenderId,
    replyToMessageId,
    isRandomTrigger,
    telegramBackpressured:
      telegramStats.messageActive >= AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER ||
      telegramStats.messageRetryPending >= AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER,
    imageGenerationRequested,
    // 同 workers/aiChat/rollingMemory.ts：字段一律发出，不用条件展开。这条消息
    // 走在每次 AI 触发的路径上，两种形状轮着产生会让 Worker 侧的读取变多态。
    imageGenerationReference,
    // 同理恒发。本群没登记问答时是 undefined，Worker 侧据此不挂那两个工具；
    // structuredClone 会复制这张 Map，两条线程不共享可变内存。载荷有界：
    // 每群至多 CHAT_QA_MAX_PER_CHAT 条。
    chatQa: getChatQa(chatId),
    // 话题群里除「挂了回复」之外的每一条主动发送都靠它才落回原话题；同样恒发，
    // General 与非论坛群是显式 undefined（见 libs/forumTopic.ts）。
    messageThreadId,
  });
}
