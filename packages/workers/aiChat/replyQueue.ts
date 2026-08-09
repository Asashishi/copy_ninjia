import { displayBufferedMessageName } from "../../aiChat/ai/utils/chatTranscript";
import {
  QUEUED_TRIGGER_SNIPPET_MAX_CHARS,
  REPLY_ROUND_MAX_CONCURRENT,
} from "../../consts/aiChat/rateLimit";
import {
  activeReplyCounts,
  pendingOverflowNotices,
  pendingReplyTriggers,
} from "../../cache/workers/aiChat/replies";
import { LinkedQueue } from "../../libs/linkedQueue";
import { truncateInline } from "../../libs/text";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { QueuedReplyTrigger } from "../../types/aiChat/replies";
import type { TriggerKind } from "../../types/states/replyAdmission";
import type { MediaCommentContext } from "../../types/aiChat/replies";
import { resolvedTagFor } from "./mediaText";
import { notifyRateLimited } from "./replyState";
import { lookupBufferedMessage, replyReferenceForBufferedEntry } from "./replyChain";

/** 分类顺序与原短路判断一致：随机触发优先于媒体触发。 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "mediaDirect" : "mediaRandom";
  return "direct";
}

/**
 * 保存直接触发的必要快照。媒体解析可能异步完成，直接使用已解析的发送人和
 * 描述；文本触发按 replyToMessageId 到热区索引里取那一条。
 *
 * **不能取缓冲区尾条**：主线程把 `record` 与 `trigger` 作为两条独立消息投过来，
 * 两者之间在途轮次的 `onMessageSent` 完全可能把机器人自己的消息推进 chatBuffers。
 * 那时尾条就是机器人自己那句，排队轮跑起来后提示词会渲染成「XX 也在跟你说话
 * （TA 说的是：「机器人上一句」）」——模型对着自己编造的内容回复。触发消息的
 * id 调用方已经解析好了，直接按 id 取（同 generateAndSendReply 的
 * replyReferenceForBufferedMessage）。
 */
export interface PushReplyTriggerParams {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  telegramBackpressured: boolean;
  imageGenerationRequested: boolean;
  imageGenerationReference?: QueuedReplyTrigger["imageGenerationReference"];
  triggerReference?: BufferedReplyReference;
  mediaTrigger?: MediaCommentContext;
}

export function pushReplyTrigger({
  chatId,
  triggerSenderId,
  replyToMessageId,
  telegramBackpressured,
  imageGenerationRequested,
  imageGenerationReference,
  triggerReference,
  mediaTrigger,
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
      ...(capturedTriggerReference ? { triggerReference: capturedTriggerReference } : {}),
      ...(mediaTrigger.replyTo ? { replyTo: mediaTrigger.replyTo } : {}),
      ...(mediaTrigger.forwardedFrom ? { forwardedFrom: mediaTrigger.forwardedFrom } : {}),
      imageGenerationRequested,
      ...(imageGenerationReference ? { imageGenerationReference } : {}),
      senderName: mediaTrigger.senderName,
      text: truncateInline(
        mediaTrigger.triggerText ?? resolvedTagFor(mediaTrigger.kind, mediaTrigger.description),
        QUEUED_TRIGGER_SNIPPET_MAX_CHARS
      ),
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
    ...(capturedTriggerReference ? { triggerReference: capturedTriggerReference } : {}),
    ...(triggerEntry?.replyTo ? { replyTo: triggerEntry.replyTo } : {}),
    ...(triggerEntry?.forwardedFrom ? { forwardedFrom: triggerEntry.forwardedFrom } : {}),
    imageGenerationRequested,
    ...(imageGenerationReference ? { imageGenerationReference } : {}),
    senderName: triggerEntry ? displayBufferedMessageName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
  });
}

/**
 * 把「队列已满、等当前这一轮收尾再提示」欠下的那条溢出提示补发出去。
 *
 * **必须与推队列分开**：这条提示是欠着群成员的一句话，窗口满不满都得发；而推
 * 队列在窗口仍然满时必须跳过（见 replyPipeline.ts 的 drainReplyQueueIfWindowAllows）。
 * 两件事写在一起的话，要么提示跟着被跳过、永远发不出去，要么推队列跟着不设闸、
 * 每轮结束空转一次限频闸，变成每分钟往群里刷一条限频提示。
 */
export function flushOverflowNotice(chatId: number): void {
  if (pendingOverflowNotices.delete(chatId)) {
    notifyRateLimited(chatId, Date.now());
  }
}

/**
 * 在并发位空出后按 FIFO 补跑直接触发。启动回调会同步占用并发位，并回报本次
 * 是否真的开了一轮；没开成就停下，把这条留在队首。
 *
 * 「没开成就继续看下一项」是错的：限频闸只看这个群 5 分钟窗口内的轮数，与
 * 具体是哪一条触发无关（见 states/replyAdmission.ts 的 admitRound），第一条被
 * 拒就意味着后面每一条都会被拒。而被拒时并发计数不增长，循环条件永远为真——
 * 一次 drain 会在同一个同步 tick 里把队列上限 25 条 @提及/回复整队 shift 掉
 * 全部丢弃，那 25 个人一句回复都收不到，还只收得到一条限频提示（提示本身有
 * 60 秒冷却）。留在队首则等窗口空出来后由下一轮结束时的 drain 补跑。
 */
export function drainReplyQueue(chatId: number, startQueuedRound: (trigger: QueuedReplyTrigger) => boolean): void {
  const queue: LinkedQueue<QueuedReplyTrigger> | undefined = pendingReplyTriggers.get(chatId);
  if (!queue) return;
  while (queue.size > 0) {
    const trigger: QueuedReplyTrigger | undefined = queue.peek();
    if (trigger === undefined) break;
    const maxConcurrent: number = trigger.telegramBackpressured
      ? 1
      : REPLY_ROUND_MAX_CONCURRENT;
    if ((activeReplyCounts.get(chatId) ?? 0) >= maxConcurrent) break;
    // 先 peek、开成了再出队：拒绝的那一条不能被吞掉。回调是同步的（真正的
    // 生成发送 fire-and-forget，onFinished 至少晚一个微任务），因此这里不会
    // 被自己重入。
    if (!startQueuedRound(trigger)) break;
    queue.shift();
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}
