import { startChatActionHeartbeat } from "../../aiChat/ai/chatActionHeartbeat";
import { createStickerSendLock } from "../../aiChat/ai/stickers/sendLock";
import { createReplyToolset } from "../../aiChat/ai/tools/replyToolset/orchestrator";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { botInfoState, superAdminUserIdState } from "../../cache/workers/aiChat/identity";
import { activeReplyCounts, longTriggerTimes } from "../../cache/workers/aiChat/replies";
import { AI_TEXT_TYPO_PROBABILITY } from "../../consts/aiChat/tools";
import {
  RATE_LIMIT_LONG_MAX_TRIGGERS,
  RATE_LIMIT_LONG_WINDOW_MS,
  QUEUED_TRIGGER_SNIPPET_MAX_CHARS,
} from "../../consts/aiChat/rateLimit";
import { SEND_MESSAGE_TOOL } from "../../consts/tools";
import { logger } from "../../infra/logger";
import { TimestampDeque } from "../../libs/timestampDeque";
import { raceAbort } from "../../libs/abortSignal";
import { truncateInline } from "../../libs/text";
import { admitRound } from "../../states/replyAdmission";
import type { AiBotInfo, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { BufferedReplyReference } from "../../types/aiChat/memory";
import type {
  QueuedReplyTrigger,
  ReplyPromptSections,
  ReplyToolContext,
  ReplyToolset,
  ReplyDeliveryTurn,
} from "../../types/aiChat/replies";
import type { StickerSendLockControl } from "../../types/stickers/tools";
import { generateReply } from "./replyModel";
import { reserveReplyDelivery } from "./replyDelivery";
import { buildReplyPromptSections } from "./promptContext";
import type { MediaCommentContext } from "../../types/aiChat/replies";
import { replyReferenceForBufferedMessage } from "./bufferedMessageIndex";
import {
  currentReplyGeneration,
  isReplyGenerationCurrent,
  notifyRateLimited,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyState";
import { recordChatMessage } from "./rollingMemory";
import type { ChatActionHeartbeatControl } from "../../types/aiChat/chatAction";

export interface ReplyRoundRequest {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  imageGenerationRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  /** 轮次开始前捕获的触发消息快照；生成或排队期间滑出热区时用于自录兜底。 */
  triggerReference?: BufferedReplyReference;
  isRandomTrigger: boolean;
  /** 触发时刻的本群问答；空或缺省时本轮不挂问答工具。 */
  chatQa?: ReadonlyMap<string, string>;
  /** 本轮全部发送要落进的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  mediaComment?: MediaCommentContext;
  mediaPreparation?: Promise<MediaCommentContext | null>;
  queuedTrigger?: QueuedReplyTrigger;
  /** 直接触发在准入时捕获代数；排队补跑省略并使用出队时的当前代数。 */
  generation?: number;
}

/**
 * 过滑动窗口限频闸并启动一轮异步回复。占位、贴纸锁和聊天状态心跳均在
 * 本函数内成对获取/释放；模型交付完整链后释放并发位并通知补跑，整轮发送按入站顺序串行。
 * @returns 本次真的开了一轮为 true；被代际失效或限频闸拒绝为 false。
 *   排队补跑那一路据此决定要不要把这条触发留在队首（见 replyQueue.ts）。
 */
export function startReplyRound(
  request: ReplyRoundRequest,
  onFinished: (chatId: number) => void,
  onModelFinished?: (chatId: number) => void
): boolean {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    imageGenerationRequested,
    imageGenerationReference,
    triggerReference,
    isRandomTrigger,
    chatQa,
    messageThreadId,
    mediaComment,
    mediaPreparation,
    queuedTrigger,
  }: ReplyRoundRequest = request;
  const generation: number = request.generation ?? currentReplyGeneration(chatId);
  if (!isReplyGenerationCurrent(chatId, generation)) return false;

  // 自动插话与随机媒体评价不得动用重媒体工具（生图、生歌）。用户直接回复/@
  // 的文字轮，以及带 directTriggerReason 的媒体轮才向工具上下文开放统一资格。
  const mediaToolsAllowed: boolean = imageGenerationRequested &&
    !isRandomTrigger &&
    (mediaComment === undefined || mediaComment.directTriggerReason !== undefined);
  // 随机媒体评价也以 isRandomTrigger=false 进入，因此直接唤起不能只看这一位。
  // 判据与上面的生图资格边界一致：普通文字非随机触发必为回复/@，媒体轮则
  // 还必须显式带 directTriggerReason。
  const directInvokerId: number | undefined =
    !isRandomTrigger && (mediaComment === undefined || mediaComment.directTriggerReason !== undefined)
      ? triggerSenderId
      : undefined;

  const selfInfo: AiBotInfo | null = botInfoState.current;
  if (!selfInfo) return false;

  const now: number = Date.now();
  let longTimes: TimestampDeque | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    // 容量取本窗口自己的配额上限：下面只在未 rateLimited 时 push，长度恒不超过它。
    longTimes = new TimestampDeque(RATE_LIMIT_LONG_MAX_TRIGGERS);
    longTriggerTimes.set(chatId, longTimes);
  }
  // 回拨会破坏 FIFO 时间队列的单调性；丢弃旧时间轴的整个窗口，
  longTimes.trim(RATE_LIMIT_LONG_WINDOW_MS, now);
  if (admitRound({ windowCount: longTimes.size }).action === "rateLimited") {
    notifyRateLimited({ chatId, now, generation, messageThreadId });
    return false;
  }

  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  const signal: AbortSignal = replyGenerationSignal(chatId, generation);
  const delivery: ReplyDeliveryTurn = reserveReplyDelivery(chatId);
  const task: Promise<void> = Promise.resolve().then(async (): Promise<void> => {
    let modelFinished: boolean = false;
    const finishModel = (): void => {
      if (modelFinished) return;
      modelFinished = true;
      const remaining: number = (activeReplyCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) activeReplyCounts.set(chatId, remaining);
      else activeReplyCounts.delete(chatId);
      onModelFinished?.(chatId);
    };
    const isActive = (): boolean =>
      !signal.aborted && isReplyGenerationCurrent(chatId, generation);
    const stickerLock: StickerSendLockControl = createStickerSendLock(chatId);
    // 提示词和工具 schema 必须共用同一次抽签，否则配置概率不等于实际错字概率。
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const resolvedMedia: MediaCommentContext | null | undefined = mediaPreparation
        ? await raceAbort(mediaPreparation, { signal, cancelled: null, rejected: null })
        : mediaComment;
      if (!isActive() || resolvedMedia === null) return;
      // 排队媒体使用入站快照的身份与回复边，只将占位正文替换为解析结果。
      const resolvedQueuedTrigger: QueuedReplyTrigger | undefined = queuedTrigger && resolvedMedia
        ? {
          ...queuedTrigger,
          triggerReference: resolvedMedia.triggerReference ?? queuedTrigger.triggerReference,
          text: truncateInline(resolvedMedia.triggerText ?? resolvedMedia.description, QUEUED_TRIGGER_SNIPPET_MAX_CHARS),
        }
        : queuedTrigger;
      const promptSections: ReplyPromptSections | null = buildReplyPromptSections(chatId, selfInfo, {
        triggerMessageId: replyToMessageId,
        ...(directInvokerId !== undefined ? { directInvokerId } : {}),
        isRandomTrigger,
        mediaComment: queuedTrigger ? undefined : resolvedMedia,
        queuedTrigger: resolvedQueuedTrigger,
        roundHasTypo,
      });
      if (!promptSections) return;

      // 心跳从 idle 起步，只有具体发送工具临发前才显示输入或选择贴纸状态。
      const heartbeat: ChatActionHeartbeatControl =
        startChatActionHeartbeat({ chatId, messageThreadId, signal });
      try {
        /** 只为 Telegram 实际返回的回复目标建边；目标已滑出热区时退回轮次
         * 开始前捕获的触发快照。 */
        const selfReplyReferenceFor = (
          repliedToMessageId: number | undefined
        ): BufferedReplyReference | undefined => repliedToMessageId === undefined
          ? undefined
          : replyReferenceForBufferedMessage(chatId, repliedToMessageId) ??
            (resolvedMedia?.triggerReference?.messageId === repliedToMessageId ? resolvedMedia.triggerReference : undefined) ??
            (triggerReference?.messageId === repliedToMessageId ? triggerReference : undefined);
        /** 四个自发消息回调唯一的差别是文案来源，贴纸没有回复关系可还原。
         * 主线程认自己的消息不靠这里回投——代理边界在把 id 交回本线程之前就已
         * 登记（见 infra/telegram/workerRequests.ts 的 markWorkerSentMessage），
         * 因此这里只剩自录转录一件事。任何一份拷贝漏掉 isActive() 都会把已经
         * 作废那一轮的自发消息写回热区。 */
        const recordSelfSent = (
          text: string,
          messageId: number,
          repliedToMessageId?: number
        ): void => {
          if (!isActive()) return;
          // 挂了回复的自发消息把目标还原成回复引用一起自录：自己的发言在转录里
          // 同样带「回复了谁」。请求侧固定指向触发
          // 消息，因此只采信服务端实际返回的回复关系。
          const selfReplyTo: BufferedReplyReference | undefined =
            selfReplyReferenceFor(repliedToMessageId);
          recordChatMessage(buildSelfRecordMessage({
            chatId,
            self: selfInfo,
            messageId,
            text,
            ...(selfReplyTo === undefined ? {} : { replyTo: selfReplyTo }),
          }));
        };
        const ctx: ReplyToolContext = {
          chatId,
          replyToMessageId,
          messageThreadId,
          chatQa,
          mediaToolsRequested: mediaToolsAllowed,
          ...(mediaToolsAllowed && imageGenerationReference ? { imageGenerationReference } : {}),
          bypassMediaToolCooldown: triggerSenderId === superAdminUserIdState.current,
          chatAction: heartbeat,
          stickerLock,
          roundHasTypo,
          isActive,
          signal,
          onMessageSent: recordSelfSent,
          // 贴纸没有可还原的回复关系，只登记描述。
          onStickerSent: (stickerDescription: string, messageId: number): void =>
            recordSelfSent(stickerDescription, messageId),
          onImageSent: recordSelfSent,
          onSongSent: recordSelfSent,
        };
        const toolset: ReplyToolset = await createReplyToolset(ctx, delivery.ready);
        let finalText: string | null = null;
        try {
          finalText = await generateReply(chatId, promptSections, toolset);

          // 仅在没有接纳任何动作时兜底发送最终正文；排队中的动作同样阻止重复兜底。
          if (finalText && toolset.actionsUsed() === 0) {
            const fallbackResult: string = await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: finalText, reply_to_trigger: !isRandomTrigger }));
            let fallbackError: string | null = null;
            try {
              const parsed: { error?: unknown; } = JSON.parse(fallbackResult) as { error?: unknown };
              if (typeof parsed.error === "string") fallbackError = parsed.error;
            } catch {
              // 工具结果由本地执行器构造。
            }
            if (fallbackError !== null) {
              logger.error(`AI reply fallback send failed (chat ${chatId}): ${fallbackError}`);
            }
          }
        } finally {
          delivery.commit();
          heartbeat.set("idle");
          try {
            finishModel();
          } finally {
            await toolset.settle();
          }
        }

        // 全部发送链收尾后按真实落地数记录零动作；已作废轮次保持静默。
        if (isActive() && toolset.actionsCompleted() === 0) {
          const triggerKind: string = queuedTrigger
            ? "queued"
            : mediaComment?.directTriggerReason
            ? "media-direct"
            : mediaComment
            ? "media-comment"
            : isRandomTrigger
            ? "random"
            : "direct";
          logger.error(`AI reply round ended with zero actions (chat ${chatId}, trigger=${triggerKind}, finalText=${finalText === null ? "none" : "unsent"}).`);
        }
      } finally {
        await heartbeat.stop();
      }
    } finally {
      try {
        stickerLock.release();
      } finally {
        try {
          finishModel();
        } finally {
          await delivery.finish();
          onFinished(chatId);
        }
      }
    }
  }).catch((error: unknown): void => {
    if (signal.aborted) return;
    logger.error("Error in AI reply task:", error);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return true;
}
