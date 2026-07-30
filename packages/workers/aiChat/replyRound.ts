import { startChatActionHeartbeat } from "../../ai/chatActionHeartbeat";
import { createStickerSendLock } from "../../ai/stickers/sendLock";
import { createReplyToolset } from "../../ai/tools/replyToolset/orchestrator";
import { buildSelfRecordContext } from "../../ai/utils/selfRecord";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { activeReplyCounts, longTriggerTimes } from "../../cache/workers/aiChat/replies";
import { AI_TEXT_TYPO_PROBABILITY } from "../../consts/aiChat/tools";
import { RATE_LIMIT_LONG_WINDOW_MS } from "../../consts/aiChat/rateLimit";
import { SEND_MESSAGE_TOOL } from "../../consts/tools";
import { SUPER_ADMIN_USER_ID } from "../../infra/config";
import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
import { admitRound } from "../../states/replyAdmission";
import type { AiBotInfo, AiSentMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { BufferedReplyReference } from "../../types/aiChat/memory";
import type {
  QueuedReplyTrigger,
  ReplyPromptSections,
  ReplyToolContext,
  ReplyToolset,
} from "../../types/aiChat/replies";
import type { StickerSendLockControl } from "../../types/stickers/tools";
import { callGemini } from "./geminiReply";
import { buildReplyPromptSections, type MediaCommentContext } from "./promptContext";
import { replyReferenceForBufferedMessage } from "./replyChain";
import {
  currentReplyGeneration,
  isReplyGenerationCurrent,
  notifyRateLimited,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyState";
import { recordChatMessage } from "./rollingMemory";
import { trimSlidingWindow } from "../../libs/slidingWindowRateLimit";
import type { ChatActionHeartbeatControl } from "../../types/aiChat/chatAction";

declare const self: Worker;

export interface ReplyRoundRequest {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  imageGenerationRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  /** 轮次开始前捕获的触发消息快照；生成或排队期间滑出热区时用于自录兜底。 */
  triggerReference?: BufferedReplyReference;
  isRandomTrigger: boolean;
  mediaComment?: MediaCommentContext;
  queuedTrigger?: QueuedReplyTrigger;
  /** 直接触发在准入时捕获代数；排队补跑省略并使用出队时的当前代数。 */
  generation?: number;
}

/**
 * 过滑动窗口限频闸并启动一轮异步回复。占位、贴纸锁和聊天状态心跳均在
 * 本函数内成对获取/释放；完成回调用于让编排层继续排空等候队列。
 * @returns 本次真的开了一轮为 true；被代际失效或限频闸拒绝为 false。
 *   排队补跑那一路据此决定要不要把这条触发留在队首（见 replyQueue.ts）。
 */
export function startReplyRound(request: ReplyRoundRequest, onFinished: (chatId: number) => void): boolean {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    imageGenerationRequested,
    imageGenerationReference,
    triggerReference,
    isRandomTrigger,
    mediaComment,
    queuedTrigger,
  }: ReplyRoundRequest = request;
  const generation: number = request.generation ?? currentReplyGeneration(chatId);
  if (!isReplyGenerationCurrent(chatId, generation)) return false;

  // 自动插话与随机媒体评价永远不得生图。这里在工具上下文
  // 边界再做一次强制收紧，不依赖各入口永远正确传 false；用户直接
  // 回复/@ 的文字轮，以及带 directTriggerReason 的媒体轮才可开放资格。
  const imageGenerationAllowed: boolean = imageGenerationRequested &&
    !isRandomTrigger &&
    (mediaComment === undefined || mediaComment.directTriggerReason !== undefined);

  const selfInfo: AiBotInfo | null = botInfoState.current;
  if (!selfInfo) return false;

  const now: number = Date.now();
  let longTimes: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new LinkedQueue<number>();
    longTriggerTimes.set(chatId, longTimes);
  }
  // 回拨会破坏 FIFO 时间队列的单调性；丢弃旧时间轴的整个窗口，
  trimSlidingWindow({ timestamps: longTimes, windowMs: RATE_LIMIT_LONG_WINDOW_MS, now });
  if (admitRound({ windowCount: longTimes.size }).action === "rateLimited") {
    notifyRateLimited(chatId, now, generation);
    return false;
  }

  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  const signal: AbortSignal = replyGenerationSignal(chatId, generation);
  const task: Promise<void> = (async (): Promise<void> => {
    const isActive = (): boolean =>
      !signal.aborted && isReplyGenerationCurrent(chatId, generation);
    const stickerLock: StickerSendLockControl = createStickerSendLock(chatId);
    // 提示词和工具 schema 必须共用同一次抽签，否则配置概率不等于实际错字概率。
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const promptSections: ReplyPromptSections | null = buildReplyPromptSections(chatId, selfInfo, {
        triggerMessageId: replyToMessageId,
        isRandomTrigger,
        mediaComment,
        queuedTrigger,
        roundHasTypo,
      });
      if (!promptSections) return;

      // 心跳从 idle 起步，只有具体发送工具临发前才显示输入或选择贴纸状态。
      const heartbeat: ChatActionHeartbeatControl =
        startChatActionHeartbeat(chatId, undefined, signal);
      try {
        /** 只为 Telegram 实际返回的回复目标建边；目标已滑出热区时退回轮次
         * 开始前捕获的触发快照。 */
        const selfReplyReferenceFor = (
          repliedToMessageId: number | undefined
        ): BufferedReplyReference | undefined => repliedToMessageId === undefined
          ? undefined
          : replyReferenceForBufferedMessage(chatId, repliedToMessageId) ??
            (triggerReference?.messageId === repliedToMessageId ? triggerReference : undefined);
        const ctx: ReplyToolContext = {
          chatId,
          replyToMessageId,
          imageGenerationRequested: imageGenerationAllowed,
          ...(imageGenerationAllowed && imageGenerationReference ? { imageGenerationReference } : {}),
          bypassImageGenerationCooldown: triggerSenderId === SUPER_ADMIN_USER_ID,
          chatAction: heartbeat,
          stickerLock,
          roundHasTypo,
          isActive,
          signal,
          onMessageSent: (text: string, messageId: number, repliedToMessageId?: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              // 挂了回复的自发消息把目标还原成回复引用一起自录：自己的发言
              // 在转录里同样带「回复了谁」，回复链也能穿过机器人的消息。
              const selfReplyTo: BufferedReplyReference | undefined = selfReplyReferenceFor(repliedToMessageId);
              recordChatMessage({
                ...buildSelfRecordContext({ chatId, self: selfInfo, messageId, ...(selfReplyTo ? { replyTo: selfReplyTo } : {}) }),
                text,
              });
            }
          },
          onStickerSent: (stickerDescription: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              recordChatMessage({
                ...buildSelfRecordContext({ chatId, self: selfInfo, messageId }),
                text: stickerDescription,
              });
            }
          },
          onImageSent: (imageDescription: string, messageId: number, repliedToMessageId?: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              // 同 onMessageSent：图片请求固定指向触发消息，自录只采信服务端
              // 实际返回的回复关系。
              const selfReplyTo: BufferedReplyReference | undefined = selfReplyReferenceFor(repliedToMessageId);
              recordChatMessage({
                ...buildSelfRecordContext({ chatId, self: selfInfo, messageId, ...(selfReplyTo ? { replyTo: selfReplyTo } : {}) }),
                text: imageDescription,
              });
            }
          },
        };
        const toolset: ReplyToolset = await createReplyToolset(ctx);
        const finalText: string | null = await callGemini(chatId, promptSections, toolset);

        // 模型没有成功执行任何可见动作、却把正文留在最终响应时，仍走
        // send_message 兜底。若贴纸、图片、反应或文字已经成功落地，尾随正文
        // 不再形成额外发言；模型真想补充文字就必须显式调用 send_message。
        if (finalText && toolset.actionsUsed() === 0) {
          const fallbackResult: string = await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: finalText, reply_to_trigger: !isRandomTrigger }));
          let fallbackError: string | null = null;
          try {
            const parsed: { error?: unknown; } = JSON.parse(fallbackResult) as { error?: unknown };
            if (typeof parsed.error === "string") fallbackError = parsed.error;
          } catch {
            // 工具结果都是 replyToolset 自己拼的 JSON，解析不会失败；防御性兜底。
          }
          if (fallbackError !== null) {
            logger.error(`AI reply fallback send failed (chat ${chatId}): ${fallbackError}`);
          }
        }

        // 零动作轮点名记录：直接触发的「已读不回」只能靠这条日志观测——
        // 模型违背「必须回应」指令、callGemini 的各条失败路径、兜底发送
        // 失败都会落进来。被 invalidate 的轮除外（/ai_chat disable 的预期
        // 沉默，不算失踪）。
        if (isActive() && toolset.actionsUsed() === 0) {
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
      stickerLock.release();
      const remaining: number = (activeReplyCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) activeReplyCounts.set(chatId, remaining);
      else activeReplyCounts.delete(chatId);
      onFinished(chatId);
    }
  })().catch((error: unknown): void => {
    if (signal.aborted) return;
    logger.error("Error in AI reply task:", error);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return true;
}
