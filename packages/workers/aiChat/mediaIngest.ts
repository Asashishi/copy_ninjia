import { sanitizeInline } from "../../libs/text";
import { displayBufferedMessageName } from "../../ai/utils/chatTranscript";
import { getCatalogEntry } from "../../ai/stickers/catalog";
import { describeMedia } from "../../ai/imageDescription";
import { dirtyMemoryChats } from "../../cache/aiChat/memory";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiRecordMediaMessage, ImageGenerationReference } from "../../types/aiChat/protocol";
import { composeMediaText, fallbackTextFor, pendingPlaceholderFor, replyFallbackDescriptionFor, resolvedTagFor } from "./mediaText";
import { buildBufferedMessage } from "./bufferedMessage";
import { pushBufferedMessage } from "./rollingMemory";
import { currentReplyGeneration, generateAndSendReply, isReplyGenerationCurrent } from "./replyPipeline";
import { replyReferenceForBufferedEntry } from "./replyChain";

/** 直接拿当前图片/贴纸叫机器人时附上短期参考；是否实际编辑由模型决定。GIF 不隐式混入。 */
function imageGenerationReferenceFor(msg: AiRecordMediaMessage): ImageGenerationReference | undefined {
  if (!msg.imageGenerationRequested || (msg.kind !== "photo" && msg.kind !== "sticker")) return undefined;
  return {
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    width: msg.width,
    height: msg.height,
  };
}

/**
 * 记录一条图片/贴纸/GIF 消息：先以占位文本立即入缓存（保住它在对话时序里
 * 的位置），再异步下载/解析媒体，解析完直接改写同一个条目对象的 text
 * 字段回填描述。改写对象而不是回队列里找：条目引用一直攥在手里，即便这
 * 期间缓存滚动、该条目已被 compaction.ts 的 scheduleRotation 快照进镜像批次
 * （快照数组存的也是同一批对象引用），只要压缩调用还没把它序列化出去，
 * 回填一样能生效；已经被压缩/滑出的极端情形，摘要里留下的就是占位文本，
 * 可接受。解析失败回填为兜底文本（见 fallbackTextFor），明确告诉模型这行
 * 没有可用内容（贴纸例外，退回元数据行仍是可用信息）。
 *
 * 贴纸额外走一条捷径：若这枚贴纸恰好来自白名单包、目录里已经有现成描述
 * （见 ai/stickers/catalog.ts 的 getCatalogEntry），直接一步到位写入描述，
 * 跳过占位与异步解析——群友发的贴纸不少概率命中机器人自己也在用的白名单
 * 包，省一次视觉调用。
 *
 * 主线程掷中评价（msg.commentOnResolve，概率/quiet/冷却都在那边把过关）
 * 且描述解析成功时，紧接着以「回复那条消息」的形式发一条针对这份媒体
 * 内容的评价（见 replyPipeline.ts 的 generateAndSendReply 的 mediaComment）——
 * 回填先于触发，模型拼上下文时看到的已是描述而非占位。解析失败没内容可评，
 * 静默放弃。
 *
 * msg.directTrigger（用户拿这份媒体回复机器人，或 caption 里 @ 机器人，见
 * auto/message/）则是必触发：白名单目录命中时立即回；未命中等 describeMedia
 * （内部自带 file_unique_id 描述缓存）解析完成再回；解析失败也用兜底文本回
 * ——真人在等回应，评价那套「失败静默放弃」在这里就是被投诉的「已读不回」。
 *
 * 相册（一次发多张图）在 Telegram 侧本来就是多条相邻消息、各带一张图，
 * 天然逐条走这里，互不影响；每条媒体消息各自占位、各自异步解析。
 */
export function recordChatMedia(msg: AiRecordMediaMessage): void {
  const generation: number = currentReplyGeneration(msg.chatId);
  const sanitizedCaption: string = sanitizeInline(msg.caption);
  const imageGenerationReference: ImageGenerationReference | undefined = imageGenerationReferenceFor(msg);

  if (msg.kind === "sticker") {
    const catalogEntry = getCatalogEntry(msg.fileUniqueId);
    if (catalogEntry) {
      const entry: BufferedMessage = buildBufferedMessage(
        msg,
        composeMediaText(resolvedTagFor("sticker", catalogEntry.description), sanitizedCaption)
      )!;
      pushBufferedMessage(msg.chatId, entry);
      if (msg.directTrigger) {
        generateAndSendReply({
          chatId: msg.chatId,
          triggerSenderId: msg.senderId,
          replyToMessageId: msg.messageId,
          isRandomTrigger: false,
          imageGenerationRequested: msg.imageGenerationRequested,
          ...(imageGenerationReference ? { imageGenerationReference } : {}),
          mediaComment: {
            kind: "sticker",
            senderId: entry.id,
            senderName: displayBufferedMessageName(entry),
            description: catalogEntry.description,
            triggerText: entry.text,
            triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
            directTriggerReason: msg.directTrigger.reason,
            ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
            ...(entry.forwardedFrom ? { forwardedFrom: entry.forwardedFrom } : {}),
          },
        });
      } else if (msg.commentOnResolve) {
        generateAndSendReply({
          chatId: msg.chatId,
          triggerSenderId: msg.senderId,
          replyToMessageId: msg.messageId,
          isRandomTrigger: false,
          imageGenerationRequested: false,
          mediaComment: {
            kind: "sticker",
            senderId: entry.id,
            senderName: displayBufferedMessageName(entry),
            description: catalogEntry.description,
            triggerText: entry.text,
            triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
            ...(entry.forwardedFrom ? { forwardedFrom: entry.forwardedFrom } : {}),
          },
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
  // describeMedia 内部兜住一切异常只返回 null，这条异步链不会 reject；
  // 同一份媒体按 file_unique_id 去重，不同媒体则经过全局有界执行器，避免
  // 洪峰同时启动无界的下载、转码和视觉请求。
  void describeMedia(msg.kind, msg.fileId, msg.fileUniqueId).then((description: string | null) => {
    if (!isReplyGenerationCurrent(msg.chatId, generation)) return;
    entry.text = composeMediaText(description ? resolvedTagFor(msg.kind, description) : fallbackTextFor(msg.kind, msg), sanitizedCaption);
    // 条目内容变了，重新标 dirty 让下一轮快照把回填后的文本落盘。
    dirtyMemoryChats.add(msg.chatId);
    if (msg.directTrigger) {
      // 回填先于触发（同评价），模型拼上下文时看到的已是描述；解析失败
      // 退回兜底文本照样触发——回应可以含糊，失踪不行。
      generateAndSendReply({
        chatId: msg.chatId,
        triggerSenderId: msg.senderId,
        replyToMessageId: msg.messageId,
        isRandomTrigger: false,
        imageGenerationRequested: msg.imageGenerationRequested,
        ...(imageGenerationReference ? { imageGenerationReference } : {}),
        mediaComment: {
          kind: msg.kind,
          senderId: entry.id,
          senderName: displayBufferedMessageName(entry),
          description: description ?? replyFallbackDescriptionFor(msg),
          triggerText: entry.text,
          triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
          directTriggerReason: msg.directTrigger.reason,
          ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
          ...(entry.forwardedFrom ? { forwardedFrom: entry.forwardedFrom } : {}),
        },
      });
    } else if (msg.commentOnResolve && description) {
      generateAndSendReply({
        chatId: msg.chatId,
        triggerSenderId: msg.senderId,
        replyToMessageId: msg.messageId,
        isRandomTrigger: false,
        imageGenerationRequested: false,
        mediaComment: {
          kind: msg.kind,
          senderId: entry.id,
          senderName: displayBufferedMessageName(entry),
          description,
          triggerText: entry.text,
          triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
          ...(entry.forwardedFrom ? { forwardedFrom: entry.forwardedFrom } : {}),
        },
      });
    }
  });
}
