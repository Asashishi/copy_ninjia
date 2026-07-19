import { startChatActionHeartbeat } from "../../ai/chatActionHeartbeat";
import { createStickerSendLock } from "../../ai/stickers/sendLock";
import { createReplyToolset } from "../../ai/tools/replyToolset";
import { botInfoState } from "../../cache/aiChat/identity";
import { activeReplyCounts, longTriggerTimes } from "../../cache/aiChat/replies";
import { AI_TEXT_TYPO_PROBABILITY } from "../../consts/aiChat/tools";
import { RATE_LIMIT_LONG_WINDOW_MS } from "../../consts/aiChat/rateLimit";
import { SEND_MESSAGE_TOOL } from "../../consts/tools";
import { SUPER_ADMIN_USER_ID } from "../../infra/config";
import { logger } from "../../infra/logger";
import { LinkedQueue } from "../../libs/linkedQueue";
import { admitRound } from "../../states/replyAdmission";
import type { AiBotInfo, AiSentMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import type { QueuedReplyTrigger, ReplyToolContext, ReplyToolset } from "../../types/aiChat/replies";
import type { StickerSendLockControl } from "../../types/stickers/tools";
import { callGemini } from "./geminiReply";
import { buildUserContent, type MediaCommentContext } from "./promptContext";
import { currentReplyGeneration, isReplyGenerationCurrent, notifyRateLimited } from "./replyState";
import { recordChatMessage } from "./rollingMemory";

declare const self: Worker;

export interface ReplyRoundRequest {
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  repliedBotText?: string;
  imageGenerationRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  isRandomTrigger: boolean;
  mediaComment?: MediaCommentContext;
  queuedTrigger?: QueuedReplyTrigger;
  /** 直接触发在准入时捕获代数；排队补跑省略并使用出队时的当前代数。 */
  generation?: number;
}

/**
 * 过滑动窗口限频闸并启动一轮异步回复。占位、贴纸锁和聊天状态心跳均在
 * 本函数内成对获取/释放；完成回调用于让编排层继续排空等候队列。
 */
export function startReplyRound(request: ReplyRoundRequest, onFinished: (chatId: number) => void): void {
  const {
    chatId,
    triggerSenderId,
    replyToMessageId,
    repliedBotText,
    imageGenerationRequested,
    imageGenerationReference,
    isRandomTrigger,
    mediaComment,
    queuedTrigger,
  } = request;
  const generation: number = request.generation ?? currentReplyGeneration(chatId);
  if (!isReplyGenerationCurrent(chatId, generation)) return;

  // 自动插话与随机媒体评价永远不得生图。这里在工具上下文
  // 边界再做一次强制收紧，不依赖各入口永远正确传 false；用户直接
  // 回复/@ 的文字轮，以及带 directTriggerReason 的媒体轮才可开放资格。
  const imageGenerationAllowed: boolean = imageGenerationRequested &&
    !isRandomTrigger &&
    (mediaComment === undefined || mediaComment.directTriggerReason !== undefined);

  const selfInfo: AiBotInfo | null = botInfoState.current;
  if (!selfInfo) return;

  const now: number = Date.now();
  let longTimes: LinkedQueue<number> | undefined = longTriggerTimes.get(chatId);
  if (!longTimes) {
    longTimes = new LinkedQueue<number>();
    longTriggerTimes.set(chatId, longTimes);
  }
  while (longTimes.size > 0 && now - longTimes.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) {
    longTimes.shift();
  }
  if (admitRound({ windowCount: longTimes.size }).action === "rateLimited") {
    notifyRateLimited(chatId, now, generation);
    return;
  }

  longTimes.push(now);
  activeReplyCounts.set(chatId, (activeReplyCounts.get(chatId) ?? 0) + 1);

  void (async (): Promise<void> => {
    const isActive = (): boolean => isReplyGenerationCurrent(chatId, generation);
    const stickerLock: StickerSendLockControl = createStickerSendLock(chatId);
    // 提示词和工具 schema 必须共用同一次抽签，否则配置概率不等于实际错字概率。
    const roundHasTypo: boolean = Math.random() < AI_TEXT_TYPO_PROBABILITY;
    try {
      const userContent: string | null = buildUserContent(chatId, selfInfo, {
        repliedBotText,
        isRandomTrigger,
        mediaComment,
        queuedTrigger,
        roundHasTypo,
      });
      if (!userContent) return;

      // 心跳从 idle 起步，只有具体发送工具临发前才显示输入或选择贴纸状态。
      const heartbeat = startChatActionHeartbeat(chatId);
      try {
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
          onMessageSent: (text: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              recordChatMessage({
                chatId,
                senderId: selfInfo.id,
                firstName: selfInfo.first_name,
                lastName: "",
                username: selfInfo.username,
                text,
              });
            }
          },
          onStickerSent: (stickerDescription: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              recordChatMessage({
                chatId,
                senderId: selfInfo.id,
                firstName: selfInfo.first_name,
                lastName: "",
                username: selfInfo.username,
                text: stickerDescription,
              });
            }
          },
          onImageSent: (imageDescription: string, messageId: number): void => {
            self.postMessage({ type: "sent", chatId, messageId } satisfies AiSentMessage);
            if (isActive()) {
              recordChatMessage({
                chatId,
                senderId: selfInfo.id,
                firstName: selfInfo.first_name,
                lastName: "",
                username: selfInfo.username,
                text: imageDescription,
              });
            }
          },
        };
        const toolset: ReplyToolset = await createReplyToolset(ctx);
        const finalText: string | null = await callGemini(chatId, userContent, toolset);

        // 模型没有调用 send_message、却把正文留在最终响应时，仍走同一工具
        // 发送。只发贴纸、图片或只扣反应的轮通常没有正文，不会重复发言。
        if (finalText && toolset.messagesSent() === 0) {
          const fallbackResult: string = await toolset.execute(SEND_MESSAGE_TOOL, JSON.stringify({ text: finalText, reply_to_trigger: !isRandomTrigger }));
          let fallbackError: string | null = null;
          try {
            const parsed = JSON.parse(fallbackResult) as { error?: unknown };
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
  })().catch((error: unknown) => {
    logger.error("Error in AI reply task:", error);
  });
}
