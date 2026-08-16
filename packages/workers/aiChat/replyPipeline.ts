import { botInfoState } from "../../cache/workers/aiChat/identity";
import { aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import {
  activeReplyCounts,
  longTriggerTimes,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/workers/aiChat/replies";
import { RATE_LIMIT_LONG_WINDOW_MS } from "../../consts/aiChat/rateLimit";
import { logger } from "../../infra/logger";
import type { LinkedQueue } from "../../libs/linkedQueue";
import { trimSlidingWindow } from "../../libs/slidingWindowRateLimit";
import { admitRound, admitTrigger } from "../../states/replyAdmission";
import type { QueuedReplyTrigger } from "../../types/aiChat/replies";
import type { BufferedReplyReference } from "../../types/aiChat/memory";
import type { AdmitDecision } from "../../types/states/replyAdmission";
import type { MediaCommentContext } from "../../types/aiChat/replies";
import {
  drainReplyQueue as drainQueuedReplies,
  flushOverflowNotice,
  pushReplyTrigger,
  triggerKindFor,
} from "./replyQueue";
import { startReplyRound } from "./replyRound";
import { currentReplyGeneration } from "./replyState";
import { replyReferenceForBufferedMessage } from "./replyChain";

export {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
  quiesceAiChatReplies,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyState";

/**
 * AI 回复准入编排。并发闸决定立即执行、排队或丢弃；滑动窗口计数和单轮
 * 工具生命周期分别由 replyRound.ts 管理，队列快照与 FIFO 由 replyQueue.ts
 * 管理。本文件保留 Worker 对外调用入口，并桥接“轮结束后继续排队补跑”。
 */

/**
 * 启动一条排队触发，并在该轮结束时继续排空同群队列。
 * @returns 本次真的开了一轮为 true；被限频闸拒绝为 false，此时这条触发要留在
 *   队首等下一次 drain（见 replyQueue.ts）。
 */
function startQueuedRound(chatId: number, trigger: QueuedReplyTrigger): boolean {
  if (aiChatWorkerQuiescing.current) return false;
  // 字段一律写全、缺省显式 undefined：startReplyRound 只有本函数与
  // generateAndSendReply 两个调用点，两处同形才只有一个隐藏类进它的解构。
  // 口径同 replyQueue.ts 的 pushReplyTrigger。
  return startReplyRound(
    {
      chatId,
      triggerSenderId: trigger.triggerSenderId,
      replyToMessageId: trigger.replyToMessageId,
      imageGenerationRequested: trigger.imageGenerationRequested,
      imageGenerationReference: trigger.imageGenerationReference,
      triggerReference: trigger.triggerReference,
      isRandomTrigger: false,
      mediaComment: undefined,
      queuedTrigger: trigger,
      generation: undefined,
    },
    onReplyRoundFinished
  );
}

/**
 * 只在 5 分钟窗口确实有余量时推一次队列。**队列的三处推力都只能走这里。**
 *
 * 窗口仍然满的群直接跳过，不做无用的尝试：startReplyRound 每被拒一次就会发一条
 * 限频提示（自带 60 秒冷却），空转就等于每分钟往群里刷一句。撞满窗口的群里轮次
 * 还在一轮接一轮地结束，不设闸的那条推力于是每轮都空转一次——刷屏由此持续整个
 * 饱和期，见 docs/cn/04-invariants.md。
 */
function drainReplyQueueIfWindowAllows(chatId: number, now: number): void {
  const times: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (times !== undefined) {
    trimSlidingWindow({ timestamps: times, windowMs: RATE_LIMIT_LONG_WINDOW_MS, now });
    if (admitRound({ windowCount: times.size }).action === "rateLimited") return;
  }
  drainQueuedReplies(chatId, (trigger: QueuedReplyTrigger): boolean => startQueuedRound(chatId, trigger));
}

/**
 * 一轮结束时的推力：先把欠下的溢出提示补出去，再按窗口余量推队列。
 *
 * 两件事分开做。提示是欠着群成员的一句话，窗口满不满都要发；推队列则必须设闸，
 * 理由见 drainReplyQueueIfWindowAllows。
 */
function onReplyRoundFinished(chatId: number): void {
  if (aiChatWorkerQuiescing.current) return;
  flushOverflowNotice(chatId);
  drainReplyQueueIfWindowAllows(chatId, Date.now());
}

/**
 * 维护节拍的兜底排空（由 aiChatWorker.ts 的 runAiChatWorkerMaintenance 调用）。
 *
 * 队列的推力有两处：轮次结束时的 onFinished，以及新触发入队后立刻试的那一次。
 * 两处都可能推不动——限频闸拒绝时 startReplyRound 根本没建任务，也就永远不会有
 * onFinished；而入队那一次撞上仍然满的窗口同样只会跳过。没有这道兜底，撞上
 * 5 分钟窗口上限的群会把最多 REPLY_TRIGGER_QUEUE_MAX 条 @提及连同它们的快照
 * （正文片段、图片引用）无限期扣在内存里，直到某次无关触发恰好完整跑完一轮
 * 才被顺带带出来。
 */
export function drainPendingReplyQueues(now: number = Date.now()): void {
  if (aiChatWorkerQuiescing.current) return;
  for (const chatId of [...pendingReplyTriggers.keys()]) {
    drainReplyQueueIfWindowAllows(chatId, now);
  }
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
  telegramBackpressured?: boolean;
  mediaComment?: MediaCommentContext;
}

export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger,
  telegramBackpressured = false,
  mediaComment,
}: GenerateAndSendReplyParams): void {
  if (aiChatWorkerQuiescing.current) return;
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
    telegramBackpressured,
  });
  switch (decision.action) {
    case "startRound":
      startReplyRound(
        {
          chatId,
          triggerSenderId,
          replyToMessageId,
          imageGenerationRequested,
          imageGenerationReference,
          triggerReference,
          isRandomTrigger,
          mediaComment,
          queuedTrigger: undefined,
          generation,
        },
        onReplyRoundFinished
      );
      break;
    case "dropSilently":
      break;
    case "enqueue":
      pushReplyTrigger({
        chatId,
        triggerSenderId,
        replyToMessageId,
        telegramBackpressured,
        imageGenerationRequested,
        imageGenerationReference,
        triggerReference,
        mediaTrigger: mediaComment,
      });
      // 入队之后立刻按 FIFO 试着推一次：并发位可能本来就是空的（上一批轮次
      // 结束时 drain 撞上限频闸停了下来，此后就没人再碰过这个队列），那时不推
      // 的话队首那些人要一直等到 30 秒的维护节拍才轮得上。先入队再推，顺序仍
      // 是先来先跑，新触发不会插到等了更久的人前面。
      drainReplyQueueIfWindowAllows(chatId, Date.now());
      break;
    case "enqueueOverflow":
      // 等当前轮收尾后再发提示，避免插进同一轮的连续短句中间。
      pendingOverflowNotices.add(chatId);
      break;
  }
}
