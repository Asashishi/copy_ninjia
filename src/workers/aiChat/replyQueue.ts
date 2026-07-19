import { displayBufferedMessageName } from "../../ai/utils/chatTranscript";
import {
  QUEUED_TRIGGER_SNIPPET_MAX_CHARS,
  REPLY_ROUND_MAX_CONCURRENT,
} from "../../consts/aiChat/rateLimit";
import {
  activeReplyCounts,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/aiChat/replies";
import { chatBuffers } from "../../cache/aiChat/memory";
import { LinkedQueue } from "../../libs/linkedQueue";
import { truncateInline } from "../../libs/text";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { QueuedReplyTrigger } from "../../types/aiChat/replies";
import type { TriggerKind } from "../../states/replyAdmission";
import type { MediaCommentContext } from "./promptContext";
import { resolvedTagFor } from "./mediaText";
import { notifyRateLimited } from "./replyState";

/** 分类顺序与原短路判断一致：随机触发优先于媒体触发。 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "mediaDirect" : "mediaRandom";
  return "direct";
}

/**
 * 保存直接触发的必要快照。媒体解析可能异步完成，直接使用已解析的发送人和
 * 描述；文本触发则读取刚写入滚动缓存的尾部消息。
 */
export function pushReplyTrigger({
  chatId,
  triggerSenderId,
  replyToMessageId,
  repliedBotText,
  mediaTrigger,
}: {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  repliedBotText: string | undefined;
  mediaTrigger?: MediaCommentContext;
}): void {
  let queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<QueuedReplyTrigger>();
    pendingReplyTriggers.set(chatId, queue);
  }
  if (mediaTrigger) {
    queue.push({
      triggerSenderId,
      replyToMessageId,
      repliedBotText,
      senderName: mediaTrigger.senderName,
      text: truncateInline(resolvedTagFor(mediaTrigger.kind, mediaTrigger.description), QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
    });
    return;
  }

  const triggerEntry: BufferedMessage | undefined = chatBuffers.get(chatId)?.last(1)[0];
  queue.push({
    triggerSenderId,
    replyToMessageId,
    repliedBotText,
    senderName: triggerEntry ? displayBufferedMessageName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
  });
}

/**
 * 在并发位空出后按 FIFO 补跑直接触发。启动回调会同步占用并发位；被限频
 * 拒绝时计数不增长，循环因此继续检查下一项。
 */
export function drainReplyQueue(chatId: number, startQueuedRound: (trigger: QueuedReplyTrigger) => void): void {
  if (pendingOverflowNotices.delete(chatId)) {
    notifyRateLimited(chatId, Date.now());
  }
  const queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) return;
  while (queue.size > 0 && (activeReplyCounts.get(chatId) ?? 0) < REPLY_ROUND_MAX_CONCURRENT) {
    startQueuedRound(queue.shift()!);
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}
