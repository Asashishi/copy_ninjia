import { botInfoState } from "../../cache/aiChat/identity";
import { activeReplyCounts, pendingOverflowNotices, pendingReplyTriggers } from "../../cache/aiChat/replies";
import { logger } from "../../infra/logger";
import { admitTrigger } from "../../states/replyAdmission";
import type { QueuedReplyTrigger } from "../../types/aiChat/replies";
import type { BufferedReplyReference } from "../../types/aiChat/memory";
import type { AdmitDecision } from "../../types/states/replyAdmission";
import type { MediaCommentContext } from "./promptContext";
import { drainReplyQueue as drainQueuedReplies, pushReplyTrigger, triggerKindFor } from "./replyQueue";
import { startReplyRound } from "./replyRound";
import { currentReplyGeneration } from "./replyState";
import { replyReferenceForBufferedMessage } from "./replyChain";

export {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
} from "./replyState";

/**
 * AI 回复准入编排。并发闸决定立即执行、排队或丢弃；滑动窗口计数和单轮
 * 工具生命周期分别由 replyRound.ts 管理，队列快照与 FIFO 由 replyQueue.ts
 * 管理。本文件保留 Worker 对外调用入口，并桥接“轮结束后继续排队补跑”。
 */

/** 启动一条排队触发，并在该轮结束时继续排空同群队列。 */
function startQueuedRound(chatId: number, trigger: QueuedReplyTrigger): void {
  startReplyRound(
    {
      chatId,
      triggerSenderId: trigger.triggerSenderId,
      replyToMessageId: trigger.replyToMessageId,
      imageGenerationRequested: trigger.imageGenerationRequested,
      ...(trigger.imageGenerationReference ? { imageGenerationReference: trigger.imageGenerationReference } : {}),
      ...(trigger.triggerReference ? { triggerReference: trigger.triggerReference } : {}),
      isRandomTrigger: false,
      queuedTrigger: trigger,
    },
    drainReplyQueue
  );
}

function drainReplyQueue(chatId: number): void {
  drainQueuedReplies(chatId, (trigger: QueuedReplyTrigger) => startQueuedRound(chatId, trigger));
}

/**
 * 接纳一次 AI 回复触发。此函数同步完成并发准入与排队决策，真正的生成发送
 * 以 fire-and-forget 方式执行，不阻塞 Worker 继续分发消息。
 */
export interface GenerateAndSendReplyParams {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  imageGenerationRequested: boolean;
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  isRandomTrigger: boolean;
  mediaComment?: MediaCommentContext;
}

export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger,
  mediaComment,
}: GenerateAndSendReplyParams): void {
  const generation: number = currentReplyGeneration(chatId);
  if (!botInfoState.current) {
    logger.error("aiChatWorker received trigger before init message; dropping.");
    return;
  }
  const triggerReference: BufferedReplyReference | undefined = mediaComment?.triggerReference ??
    replyReferenceForBufferedMessage(chatId, replyToMessageId);

  const decision: AdmitDecision = admitTrigger({
    activeRounds: activeReplyCounts.get(chatId) ?? 0,
    queueSize: pendingReplyTriggers.get(chatId)?.size ?? 0,
    kind: triggerKindFor(isRandomTrigger, mediaComment),
  });
  switch (decision.action) {
    case "startRound":
      startReplyRound(
        {
          chatId,
          triggerSenderId,
          replyToMessageId,
          imageGenerationRequested,
          ...(imageGenerationReference ? { imageGenerationReference } : {}),
          ...(triggerReference ? { triggerReference } : {}),
          isRandomTrigger,
          mediaComment,
          generation,
        },
        drainReplyQueue
      );
      break;
    case "dropSilently":
      break;
    case "enqueue":
      pushReplyTrigger({
        chatId,
        triggerSenderId,
        replyToMessageId,
        imageGenerationRequested,
        imageGenerationReference,
        triggerReference,
        mediaTrigger: mediaComment,
      });
      break;
    case "enqueueOverflow":
      // 等当前轮收尾后再发提示，避免插进同一轮的连续短句中间。
      pendingOverflowNotices.add(chatId);
      break;
  }
}
