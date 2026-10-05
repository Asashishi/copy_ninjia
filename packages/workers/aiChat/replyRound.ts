import { startChatActionHeartbeat } from "../../aiChat/ai/chatActionHeartbeat";
import { createReplyToolset } from "../../aiChat/ai/tools/replyToolset/orchestrator";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { parseToolResult } from "../../aiChat/ai/utils/toolResult";
import { botInfoState, superAdminUserIdState } from "../../cache/workers/aiChat/identity";
import {
  activeReplyCounts,
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  longTriggerTimes,
} from "../../cache/workers/aiChat/replies";
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
import { isReplyRoundRateLimited } from "../../states/replyAdmission";
import type { AiBotInfo, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type {
  QueuedReplyTrigger,
  ReplyPromptSections,
  ReplyToolContext,
  ReplyToolset,
  ReplyDeliveryTurn,
  SentGeneratedImage,
  MediaCommentContext,
} from "../../types/aiChat/replies";
import { generateReply } from "./replyModel";
import { reserveReplyDelivery } from "./replyDelivery";
import { buildReplyPromptSections } from "./promptContext";
import { replyReferenceForBufferedMessage } from "./bufferedMessageIndex";
import { notifyRateLimited } from "./replyState";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";
import { recordChatMessage } from "./rollingMemory";
import { repliedBotImageBackfill, trackGeneratedImage } from "./botImages";
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
  /** 触发时刻的本群问答；空或缺省时问答执行器返回空清单，本轮工具状态写明没有登记。 */
  chatQa?: ReadonlyMap<string, string>;
  /** 本轮全部发送要落进的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  mediaComment?: MediaCommentContext;
  mediaPreparation?: Promise<MediaCommentContext | null>;
  queuedTrigger?: QueuedReplyTrigger;
  /** 直接触发在准入时捕获代数；排队补跑省略并使用出队时的当前代数。 */
  generation?: number;
}

/** buildReplyToolContext 的输入：本轮请求与已解析的媒体、身份和生命周期句柄。 */
interface ReplyToolContextParams {
  readonly request: ReplyRoundRequest;
  readonly selfInfo: AiBotInfo;
  /** 本轮已解析的媒体上下文；非媒体轮为 undefined。 */
  readonly resolvedMedia: MediaCommentContext | undefined;
  readonly mediaToolsAllowed: boolean;
  readonly heartbeat: ChatActionHeartbeatControl;
  /** 本轮是否为直接轮（见 replyDelivery.ts）。 */
  readonly direct: boolean;
  readonly roundHasTypo: boolean;
  readonly isActive: () => boolean;
  readonly signal: AbortSignal;
}

/**
 * 拼出本轮的工具上下文，连同各发送回调的自录：消息、贴纸、语音与生图发出后按 Telegram 实际
 * 返回的回复目标写进转录（目标已滑出热区时退回媒体解析或轮次开始前捕获的触发快照），
 * 本轮已作废时一律不写。主线程认自己的消息不靠这里回投——代理边界在把 id 交回本线程之前
 * 就已登记（见 infra/telegram/workerRequests.ts 的 markWorkerSentMessage）。
 */
function buildReplyToolContext({
  request,
  selfInfo,
  resolvedMedia,
  mediaToolsAllowed,
  heartbeat,
  direct,
  roundHasTypo,
  isActive,
  signal,
}: ReplyToolContextParams): ReplyToolContext {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    messageThreadId,
    chatQa,
    imageGenerationReference,
    triggerReference,
  }: ReplyRoundRequest = request;
  const selfReplyReferenceFor = (
    repliedToMessageId: number | undefined
  ): BufferedReplyReference | undefined => repliedToMessageId === undefined
    ? undefined
    : replyReferenceForBufferedMessage(chatId, repliedToMessageId) ??
      (resolvedMedia?.triggerReference?.messageId === repliedToMessageId ? resolvedMedia.triggerReference : undefined) ??
      (triggerReference?.messageId === repliedToMessageId ? triggerReference : undefined);
  /** 各发送回调唯一的差别是文案来源；贴纸没有回复关系可还原。 */
  const recordSelfSent = (
    text: string,
    messageId: number,
    repliedToMessageId?: number
  ): BufferedMessage | null => {
    if (!isActive()) return null;
    // 请求侧固定指向触发消息，因此只采信服务端实际返回的回复关系。
    const selfReplyTo: BufferedReplyReference | undefined = selfReplyReferenceFor(repliedToMessageId);
    return recordChatMessage(buildSelfRecordMessage({
      chatId,
      self: selfInfo,
      messageId,
      text,
      replyTo: selfReplyTo,
    }));
  };
  return {
    chatId,
    replyToMessageId,
    messageThreadId,
    chatQa,
    mediaToolsRequested: mediaToolsAllowed,
    imageGenerationReference: mediaToolsAllowed ? imageGenerationReference : undefined,
    bypassMediaToolCooldown: triggerSenderId === superAdminUserIdState.current,
    chatAction: heartbeat,
    direct,
    roundHasTypo,
    isActive,
    signal,
    onMessageSent: recordSelfSent,
    // 贴纸没有可还原的回复关系，只登记描述。
    onStickerSent: (stickerDescription: string, messageId: number): void => {
      recordSelfSent(stickerDescription, messageId);
    },
    // 生图先以占位态自录，再识图原位换成画面内容。
    onImageSent: (image: SentGeneratedImage): void => {
      const entry: BufferedMessage | null = recordSelfSent(image.text, image.messageId, image.repliedToMessageId);
      if (entry === null) return;
      trackGeneratedImage({
        chatId,
        entry,
        origin: image.origin,
        caption: image.caption,
        photo: image.photo,
      });
    },
    onVoiceSent: recordSelfSent,
  };
}

/** 把模型的最终正文作为一条消息兜底发出（随机触发不挂回复）；发送失败只记日志。 */
function sendFallbackText(toolset: ReplyToolset, request: ReplyRoundRequest, finalText: string): void {
  const result: string = toolset.execute(
    SEND_MESSAGE_TOOL,
    JSON.stringify({ text: finalText, reply_to_trigger: !request.isRandomTrigger })
  );
  const error: string | null = parseToolResult(result).error;
  if (error !== null) logger.error(`AI reply fallback send failed (chat ${request.chatId}): ${error}`);
}

/** 零动作诊断日志里的触发类型。 */
function triggerKindOf({ queuedTrigger, mediaComment, isRandomTrigger }: ReplyRoundRequest): string {
  if (queuedTrigger) return "queued";
  if (mediaComment?.directTriggerReason) return "media-direct";
  if (mediaComment) return "media-comment";
  return isRandomTrigger ? "random" : "direct";
}

/**
 * 过滑动窗口限频闸并启动一轮异步回复。占位和聊天状态心跳均在
 * 本函数内成对获取/释放；模型阶段结束后释放并发位并通知补跑，整轮发送按入站顺序串行。群里没有
 * 在途轮次时本轮是直接轮，动作边生成边发送；之后的有序并行轮等它发完再按顺序出站（见 replyDelivery.ts）。
 * @returns 本次真的开了一轮为 true；被代际失效、容量或限频闸拒绝为 false。
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
    isRandomTrigger,
    messageThreadId,
    mediaComment,
    mediaPreparation,
    queuedTrigger,
  }: ReplyRoundRequest = request;
  const generation: number = request.generation ?? cachedReplyGeneration(chatId);
  if (!isCachedReplyGenerationCurrent(chatId, generation)) return false;

  // 自动插话与随机媒体评价不得动用重媒体工具（生图）。用户直接回复/@
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
  // 回拨时仅裁掉未来时间戳，保留仍在窗口内的已用配额。
  longTimes.trim(RATE_LIMIT_LONG_WINDOW_MS, now);
  if (isReplyRoundRateLimited(longTimes.size)) {
    notifyRateLimited({ chatId, now, generation, messageThreadId });
    return false;
  }

  const delivery: ReplyDeliveryTurn | undefined = reserveReplyDelivery(chatId);
  if (!delivery) return false;
  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  const signal: AbortSignal = replyGenerationSignal(generation);
  const task: Promise<void> = Promise.resolve().then(async (): Promise<void> => {
    let modelFinished: boolean = false;
    const finishModel = (): void => {
      if (modelFinished) return;
      modelFinished = true;
      const remaining: number = (activeReplyCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) activeReplyCounts.set(chatId, remaining);
      else activeReplyCounts.delete(chatId);
      // 模型阶段结束即 commit：有序并行轮的完整链就绪，直接轮交还独立并发位；补跑按新上限判定。
      delivery.commit();
      onModelFinished?.(chatId);
    };
    const isActive = (): boolean =>
      !signal.aborted && isCachedReplyGenerationCurrent(chatId, generation);
    // 提示词与 send_message 执行侧的错字处理必须共用同一次抽签，否则配置概率不等于实际错字概率。
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const resolvedMedia: MediaCommentContext | null | undefined = mediaPreparation
        ? await raceAbort(mediaPreparation, { signal, cancelled: null, rejected: null })
        : mediaComment;
      if (!isActive() || resolvedMedia === null) return;
      // 触发消息回复了机器人的图片且正在识图时，等回填完成再拼提示词（见 botImages.ts）。
      const botImageBackfill: Promise<void> | undefined = repliedBotImageBackfill(chatId, replyToMessageId);
      if (botImageBackfill !== undefined) {
        await raceAbort(botImageBackfill, { signal, cancelled: undefined, rejected: undefined });
        if (!isActive()) return;
      }
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

      // 心跳从 idle 起步：直接轮在请求模型期间亮「正在输入」，有序并行轮只由串行动作链切换状态。
      const heartbeat: ChatActionHeartbeatControl =
        startChatActionHeartbeat({ chatId, messageThreadId, signal });
      try {
        const ctx: ReplyToolContext = buildReplyToolContext({
          request,
          selfInfo,
          resolvedMedia,
          mediaToolsAllowed,
          heartbeat,
          direct: delivery.direct,
          roundHasTypo,
          isActive,
          signal,
        });
        const toolset: ReplyToolset = await createReplyToolset(ctx, delivery.ready);
        let finalText: string | null = null;
        try {
          finalText = await generateReply(chatId, promptSections, toolset);

          // 仅在没有接纳任何动作时兜底发送最终正文；排队中的动作同样阻止重复兜底。
          if (finalText && toolset.actionsUsed() === 0) sendFallbackText(toolset, request, finalText);
        } finally {
          // 模型不再被请求：收回直接轮请求期间亮着、没被动作接走的状态。
          toolset.afterModel();
          try {
            finishModel();
          } finally {
            await toolset.settle();
          }
        }

        // 全部发送链收尾后按真实落地数记录零动作；已作废轮次保持静默。finalText 为
        // null 时模型侧已记下具体原因（见 replyModel.ts 的 generateReply），此处不另记。
        if (isActive() && toolset.actionsCompleted() === 0 && finalText !== null) {
          logger.error(`AI reply round ended with zero actions (chat ${chatId}, trigger=${triggerKindOf(request)}, finalText=unsent).`);
        }
      } finally {
        await heartbeat.stop();
      }
    } finally {
      try {
        finishModel();
      } finally {
        await delivery.finish();
        onFinished(chatId);
      }
    }
  }).catch((error: unknown): void => {
    if (signal.aborted) return;
    logger.error("Error in AI reply task:", error);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return true;
}
