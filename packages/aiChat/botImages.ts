import { isAiChatActiveIn } from "./availability";
import { recordChatMessage } from "./messageIngress";
import { logger } from "../infra/logger";
import { activeCopyTargetIdIn } from "../infra/storage/stateStore";

/** recordBotImage 的入参。 */
export interface RecordBotImageParams {
  chatId: number;
  /** 这张图片消息的 message_id。 */
  messageId: number;
  /** 图注原文；没有图注传空串。 */
  caption: string;
  /** 同一条消息换了图（/wed 更换）时为 true，见 AiRecordBotImageMessage.edited。 */
  edited: boolean;
}

/**
 * 命令与定时任务发出图片后的占位自录入口（/wed、/h_image、cron send_image）。
 *
 * 只在本群正跑 AI 闲聊且没有复读目标时投递，与内联结果自录同一门槛（见
 * auto/message/guards.ts）。Worker 写入占位态条目、不识图，有人回复这张图时
 * 才识图回填（见 workers/aiChat/botImages.ts）。
 *
 * 调用点都在图片已经发出之后（多在 runTelegramAction 的 map 里），因此本函数
 * 不抛错：AI Worker 不可用时记一行错误日志并放弃这条自录，发送结果不受影响。
 */
export function recordBotImage({ chatId, messageId, caption, edited }: RecordBotImageParams): void {
  if (activeCopyTargetIdIn(chatId) !== undefined || !isAiChatActiveIn(chatId)) return;
  try {
    recordChatMessage({
      type: "recordBotImage",
      chatId,
      messageId,
      caption,
      edited,
      persistImmediately: false,
    });
  } catch (error: unknown) {
    logger.error(`Failed to record bot image ${messageId} in AI memory (chat ${chatId}):`, error);
  }
}
