import { displaySpeakerName } from "../../aiChat/ai/utils/chatTranscript";
import { QUEUED_TRIGGER_SNIPPET_MAX_CHARS } from "../../consts/aiChat/rateLimit";
import {
  activeReplyCounts,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/workers/aiChat/replies";
import { LinkedQueue } from "../../libs/linkedQueue";
import { truncateInline } from "../../libs/text";
import { replyRoundConcurrencyLimit } from "../../states/replyAdmission";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { QueuedReplyTrigger, MediaCommentContext } from "../../types/aiChat/replies";
import type { TriggerKind } from "../../types/states/replyAdmission";
import { resolvedTagFor } from "./mediaText";
import { isDirectReplyModelActive } from "./replyDelivery";
import { notifyRateLimited } from "./replyState";
import { lookupBufferedMessage, replyReferenceForBufferedEntry } from "./bufferedMessageIndex";

/** 触发分类：随机触发优先于媒体触发。 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "mediaDirect" : "mediaRandom";
  return "direct";
}

/** pushReplyTrigger 的入参。 */
export interface PushReplyTriggerParams {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  telegramBackpressured: boolean;
  imageGenerationRequested: boolean;
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  triggerReference?: BufferedReplyReference;
  /** 触发时刻的本群问答；随触发一起入队，补跑时用当时那份清单。 */
  chatQa?: ReadonlyMap<string, string>;
  /** 触发消息所在的论坛话题；补跑那一轮仍然回到当初那个话题。 */
  messageThreadId: number | undefined;
  mediaTrigger?: MediaCommentContext;
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/**
 * 保存直接触发的必要快照。媒体同步保存入站身份、占位正文和解析 Promise，
 * 补跑时使用解析结果；文本触发按 replyToMessageId 到热区索引里取那一条。
 *
 * **不取缓冲区尾条**：主线程把 `record` 与 `trigger` 作为两条独立消息投递，
 * 两者之间在途轮次的 `onMessageSent` 可能已把机器人自己的消息推进 chatBuffers。
 * 触发消息的 id 由调用方解析，直接按 id 取（同 generateAndSendReply 的
 * replyReferenceForBufferedMessage）。
 *
 * 两条分支的字段一律写全、缺省显式 undefined，不用条件展开，使排进 LinkedQueue 的
 * 对象形状一致。口径同 auto/message/recordContext.ts 与 antiRaid/adCandidate.ts。
 *
 * 空串按 undefined 归一（`x ? x : undefined`）。
 */
export function pushReplyTrigger({
  chatId,
  triggerSenderId,
  replyToMessageId,
  telegramBackpressured,
  imageGenerationRequested,
  imageGenerationReference,
  triggerReference,
  chatQa,
  messageThreadId,
  mediaTrigger,
  mediaPreparation,
}: PushReplyTriggerParams): void {
  let queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<QueuedReplyTrigger>();
    pendingReplyTriggers.set(chatId, queue);
  }
  if (mediaTrigger) {
    const capturedTriggerReference: BufferedReplyReference | undefined =
      triggerReference ?? mediaTrigger.triggerReference;
    queue.push({
      triggerSenderId,
      replyToMessageId,
      telegramBackpressured,
      triggerReference: capturedTriggerReference,
      replyTo: mediaTrigger.replyTo,
      forwardedFrom: mediaTrigger.forwardedFrom ? mediaTrigger.forwardedFrom : undefined,
      imageGenerationRequested,
      imageGenerationReference,
      chatQa,
      messageThreadId,
      senderName: mediaTrigger.senderName,
      text: truncateInline(
        mediaTrigger.triggerText ?? resolvedTagFor(mediaTrigger.kind, mediaTrigger.description),
        QUEUED_TRIGGER_SNIPPET_MAX_CHARS
      ),
      mediaPreparation,
    });
    return;
  }

  const triggerEntry: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyToMessageId);
  const capturedTriggerReference: BufferedReplyReference | undefined = triggerReference ??
    (triggerEntry ? replyReferenceForBufferedEntry(replyToMessageId, triggerEntry) : undefined);
  queue.push({
    triggerSenderId,
    replyToMessageId,
    telegramBackpressured,
    triggerReference: capturedTriggerReference,
    replyTo: triggerEntry?.replyTo,
    forwardedFrom: triggerEntry?.forwardedFrom ? triggerEntry.forwardedFrom : undefined,
    imageGenerationRequested,
    imageGenerationReference,
    chatQa,
    messageThreadId,
    senderName: triggerEntry ? displaySpeakerName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
    mediaPreparation,
  });
}

/**
 * 把「队列已满、等当前这一轮收尾再提示」欠下的那条溢出提示补发出去，不看限频窗口
 * 余量；推队列另走 replyPipeline.ts 的 drainReplyQueueIfWindowAllows。
 */
export function flushOverflowNotice(chatId: number): void {
  // 先取值再 delete：值可以是 undefined（General/非论坛群），「在不在表里」由 delete 的返回值判定。
  const messageThreadId: number | undefined = pendingOverflowNotices.get(chatId);
  if (!pendingOverflowNotices.delete(chatId)) return;
  notifyRateLimited({ chatId, now: Date.now(), messageThreadId });
}

/**
 * 按 FIFO 逐个调用启动回调；回调同步占用模型并发位并预留发送顺位后，
 * 立即移除待处理项，再按剩余模型位派发下一项，不等待发送链的结果。
 * 启动被容量或限频拒绝时保留队首并停止派发；取消与收尾由轮次的代际任务持有。
 * 具体生命周期约束见 docs/cn/04-invariants.md。
 */
export function drainReplyQueue(chatId: number, startQueuedRound: (trigger: QueuedReplyTrigger) => boolean): void {
  const queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) return;
  while (queue.size > 0) {
    const trigger: QueuedReplyTrigger | undefined = queue.peek();
    if (trigger === undefined) break;
    const maxConcurrent: number = replyRoundConcurrencyLimit(trigger.telegramBackpressured, isDirectReplyModelActive(chatId));
    if ((activeReplyCounts.get(chatId) ?? 0) >= maxConcurrent) break;
    // 先 peek，启动成功后再出队，被拒绝的触发留在队首。回调同步执行（真正的
    // 模型任务异步执行，完成回调至少晚一个微任务），这里不会被自己重入。
    if (!startQueuedRound(trigger)) break;
    queue.shift();
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}
