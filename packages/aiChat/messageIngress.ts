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
    if (shouldArm || armedRevision === null) message.persistImmediately = true;
    postAiChatOrThrow(message);
  } catch (error: unknown) {
    if (shouldArm) postPurgeAiMemoryPersistRevisions.delete(message.chatId);
    throw error;
  }
}

/** 记录一条群消息到 Worker 侧滚动上下文；主线程只负责保持 FIFO 投递顺序。 */
export function recordChatMessage(
  message: Omit<AiRecordMessage, "type" | "persistImmediately">
): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord({ type: "record", ...message });
}

/** 记录一条图片、贴纸或 GIF；媒体解析与可选评价都由 AI Worker 完成。 */
export function recordChatMedia(
  message: Omit<AiRecordMediaMessage, "type" | "persistImmediately">
): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord({ type: "recordMedia", ...message });
}

/** 触发一次回复所需的主线程载荷；随机触发默认关闭。 */
export type GenerateAndSendReplyParams = Omit<
  AiTriggerMessage,
  "type" | "isRandomTrigger"
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
}: GenerateAndSendReplyParams): void {
  postAiChatOrThrow({
    type: "trigger",
    chatId,
    triggerSenderId,
    replyToMessageId,
    isRandomTrigger,
    imageGenerationRequested,
    ...(imageGenerationReference ? { imageGenerationReference } : {}),
  });
}
