import { sanitizeInline } from "../../libs/text";
import { displayBufferedMessageName } from "../../aiChat/ai/utils/chatTranscript";
import { getCatalogEntry } from "../../aiChat/ai/stickers/catalog";
import { describeMedia } from "../../aiChat/ai/imageDescription";
import { dirtyMemoryChats } from "../../cache/workers/aiChat/memory";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiRecordMediaMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import { composeMediaText, fallbackTextFor, pendingPlaceholderFor, replyFallbackDescriptionFor, resolvedTagFor } from "./mediaText";
import { buildBufferedMessage } from "./bufferedMessage";
import { pushBufferedMessage } from "./rollingMemory";
import {
  currentReplyGeneration,
  generateAndSendReply,
  isReplyGenerationCurrent,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyPipeline";
import { replyReferenceForBufferedEntry } from "./bufferedMessageIndex";
import type { MediaCommentContext } from "../../types/aiChat/replies";
import type { StickerCatalogEntry } from "../../types/stickers/catalog";

/**
 * 直接拿当前图片/贴纸叫机器人时附上短期参考；是否实际编辑由模型决定。GIF 不隐式混入。
 *
 * 「有没有图片工具资格」直接读 directTriggerReason，不再另有一个布尔字段重复它
 * （理由见 types/aiChat/protocol.ts 的 directTriggerReason 与 messageThreadId）。
 */
function imageGenerationReferenceFor(msg: AiRecordMediaMessage): ImageGenerationReference | undefined {
  if (msg.directTriggerReason === undefined || (msg.kind !== "photo" && msg.kind !== "sticker")) {
    return undefined;
  }
  return {
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    width: msg.width,
    height: msg.height,
  };
}

/** 入站与解析完成使用同一份媒体身份、回复关系和直接触发资格。 */
function mediaCommentFor(msg: AiRecordMediaMessage, entry: BufferedMessage, description: string): MediaCommentContext {
  return {
    kind: msg.kind,
    senderId: entry.id,
    senderName: displayBufferedMessageName(entry),
    description,
    triggerText: entry.text,
    triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
    directTriggerReason: msg.directTriggerReason,
    replyTo: msg.directTriggerReason === undefined ? undefined : entry.replyTo,
    forwardedFrom: entry.forwardedFrom,
  };
}

/**
 * 媒体先同步记录并准入占位，再异步识别；识别完成回填原条目和本轮上下文。
 * 直接触发失败时使用兜底描述，随机评价失败时完成空占位。贴纸目录命中时同步使用真实描述。
 * 顺位、取消与有界容量约束见 docs/cn/04-invariants.md。
 */
export function recordChatMedia(msg: AiRecordMediaMessage): void {
  const generation: number = currentReplyGeneration(msg.chatId);
  const signal: AbortSignal = replyGenerationSignal(msg.chatId, generation);
  const sanitizedCaption: string = sanitizeInline(msg.caption);
  const imageGenerationReference: ImageGenerationReference | undefined = imageGenerationReferenceFor(msg);

  if (msg.kind === "sticker") {
    const catalogEntry: StickerCatalogEntry | undefined = getCatalogEntry(msg.fileUniqueId);
    if (catalogEntry) {
      const entry: BufferedMessage = buildBufferedMessage(
        msg,
        composeMediaText(resolvedTagFor("sticker", catalogEntry.description), sanitizedCaption)
      )!;
      pushBufferedMessage(msg.chatId, entry);
      if (msg.directTriggerReason !== undefined || msg.commentOnResolve) {
        generateAndSendReply({
          chatId: msg.chatId,
          triggerSenderId: msg.senderId,
          replyToMessageId: msg.messageId,
          messageThreadId: msg.messageThreadId,
          isRandomTrigger: false,
          imageGenerationRequested: msg.directTriggerReason !== undefined,
          ...(imageGenerationReference ? { imageGenerationReference } : {}),
          mediaComment: mediaCommentFor(msg, entry, catalogEntry.description),
        });
      }
      return;
    }
  }

  const entry: BufferedMessage = buildBufferedMessage(
    msg,
    composeMediaText(pendingPlaceholderFor(msg.kind), sanitizedCaption)
  )!;
  pushBufferedMessage(msg.chatId, entry);
  const preparation: PromiseWithResolvers<MediaCommentContext | null> | undefined =
    msg.directTriggerReason !== undefined || msg.commentOnResolve
      ? Promise.withResolvers<MediaCommentContext | null>()
      : undefined;
  if (preparation) {
    generateAndSendReply({
      chatId: msg.chatId,
      triggerSenderId: msg.senderId,
      replyToMessageId: msg.messageId,
      messageThreadId: msg.messageThreadId,
      isRandomTrigger: false,
      imageGenerationRequested: msg.directTriggerReason !== undefined,
      ...(imageGenerationReference ? { imageGenerationReference } : {}),
      mediaComment: mediaCommentFor(msg, entry, ""),
      mediaPreparation: preparation.promise,
    });
  }
  // 描述缓存按 file_unique_id 去重，下载、转码与视觉请求经过全局有界执行器。
  const task: Promise<void> = describeMedia({
    kind: msg.kind,
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    voiceMime: msg.voiceMime,
    voiceDurationSeconds: msg.voiceDurationSeconds,
    signal,
  }).then((description: string | null): void => {
    if (!isReplyGenerationCurrent(msg.chatId, generation)) return;
    entry.text = composeMediaText(description ? resolvedTagFor(msg.kind, description) : fallbackTextFor(msg.kind, msg), sanitizedCaption);
    dirtyMemoryChats.add(msg.chatId);
    if (preparation && (msg.directTriggerReason !== undefined || description)) {
      preparation.resolve(mediaCommentFor(msg, entry, description ?? replyFallbackDescriptionFor(msg)));
    }
  }).finally((): void => { preparation?.resolve(null); });
  trackReplyGenerationTask(msg.chatId, generation, task);
}
