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
import { lookupBufferedMessage, replyReferenceForBufferedEntry } from "./bufferedMessageIndex";

/** 分类顺序与原短路判断一致：随机触发优先于媒体触发。 */
export function triggerKindFor(isRandomTrigger: boolean, mediaComment: MediaCommentContext | undefined): TriggerKind {
  if (isRandomTrigger) return "random";
  if (mediaComment) return mediaComment.directTriggerReason ? "mediaDirect" : "mediaRandom";
  return "direct";
}

/**
 * 保存直接触发的必要快照。媒体同步保存入站身份、占位正文和解析 Promise，
 * 补跑时使用解析结果；文本触发按 replyToMessageId 到热区索引里取那一条。
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
  /** 触发时刻的本群问答；随触发一起入队，补跑时用当时那份清单。 */
  chatQa?: ReadonlyMap<string, string>;
  /** 触发消息所在的论坛话题；补跑那一轮仍然回到当初那个话题。 */
  messageThreadId: number | undefined;
  mediaTrigger?: MediaCommentContext;
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/**
 * 两条分支的字段一律写全、缺省显式 undefined，不用条件展开：这些对象会推进
 * LinkedQueue 长期排着，随后被 drainReplyQueue 与 startQueuedRound 逐字段反复读，
 * 四个可选字段各自展开会让同一个类型分出至多 16 个隐藏类。口径同
 * auto/message/recordContext.ts 与 antiRaid/adCandidate.ts。
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
    senderName: triggerEntry ? displayBufferedMessageName(triggerEntry) : "",
    text: triggerEntry ? truncateInline(triggerEntry.text, QUEUED_TRIGGER_SNIPPET_MAX_CHARS) : "",
    mediaPreparation,
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
  // 先取值再 delete：值本身可以是 undefined（General/非论坛群），因此「在不在表里」
  // 只能由 delete 的返回值回答，不能靠 get 是不是 undefined 判断。两次查找足够，
  // 不需要再多一次 has。
  const messageThreadId: number | undefined = pendingOverflowNotices.get(chatId);
  if (!pendingOverflowNotices.delete(chatId)) return;
  notifyRateLimited({ chatId, now: Date.now(), messageThreadId });
}

/**
 * 按 FIFO 逐个调用启动回调；回调同步占用模型并发位并预留发送顺位后，
 * 立即移除待处理项，再按剩余模型位派发下一项，不等待发送链的结果。
 * 启动被限频拒绝时保留队首并停止派发；取消与收尾由轮次的代际任务持有。
 * 具体生命周期约束见 docs/cn/04-invariants.md。
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
    // 模型任务异步执行，完成回调至少晚一个微任务），因此这里不会
    // 被自己重入。
    if (!startQueuedRound(trigger)) break;
    queue.shift();
  }
  if (queue.size === 0) pendingReplyTriggers.delete(chatId);
}
