import { describeMedia } from "../../aiChat/ai/imageDescription";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { repliedBotImageBackfills } from "../../cache/workers/aiChat/botImages";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { dirtyMemoryChats } from "../../cache/workers/aiChat/memory";
import { cachedReplyGeneration, isCachedReplyGenerationCurrent } from "../../cache/workers/aiChat/replies";
import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { sanitizeInline, truncateInline } from "../../libs/text";
import type { BotImageOrigin, BufferedMessage, BufferedReplyReference, PendingBotImage } from "../../types/aiChat/memory";
import type { AiBotInfo, AiRecordBotImageMessage, RepliedBotImage } from "../../types/aiChat/protocol";
import type { TelegramVisionSource } from "../../types/media";
import { buildBufferedMessage } from "./bufferedMessage";
import { lookupBufferedMessage } from "./bufferedMessageIndex";
import { botImageText } from "./mediaText";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";
import { pushBufferedMessage } from "./rollingMemory";

/**
 * 机器人自发图片在滚动记忆里的两种状态与它们之间唯一的转换。
 *
 * - 占位态：条目带 pendingImage，text 只有自录记号（生图带提示词）与图注。命令与
 *   定时任务发的图（recordBotImage）和刚落地的生图（trackGeneratedImage）都先以
 *   占位态按 message_id 写进热区。
 * - 内容态：pendingImage 为 undefined，text 的记号里是识图描述。
 *
 * 生图落地即开始识图；命令图不主动识图，只在有人回复它时识图（resolveRepliedBotImage）。
 * 两条路都经 describeBotImage 回填，同一张图的并发识别由 describeMedia 按
 * file_unique_id 合并，已是内容态的图被回复时直接复用正文、不再识图。
 * 识图失败时条目保持占位态，下一次被回复时重试。
 */

/** 一张机器人图片的识图参数：图片本体，以及它在热区里那条条目的占位状态。 */
interface BotImageTarget {
  readonly chatId: number;
  readonly messageId: number;
  readonly fileId: string;
  readonly fileUniqueId: string;
  /**
   * 识图开始时条目上的 pendingImage 对象；条目不在热区时为 undefined。回填只在
   * 条目仍持有同一个对象时进行：/wed 换图会换上新的占位对象，旧图迟到的描述
   * 因此不会写进新图的条目。
   */
  readonly pending: PendingBotImage | undefined;
}

/** 条目仍在热区且仍持有识图开始时的那份占位状态时，把它改写成内容态；其余情况不动。 */
function fillBotImage({ chatId, messageId, pending }: BotImageTarget, description: string): void {
  if (pending === undefined) return;
  const entry: BufferedMessage | undefined = lookupBufferedMessage(chatId, messageId);
  if (entry?.pendingImage !== pending) return;
  entry.text = botImageText(pending.origin, description, pending.caption);
  entry.pendingImage = undefined;
  dirtyMemoryChats.add(chatId);
}

/**
 * 识别一张机器人图片并回填占位态条目，随后调用 onDescribed。识别随当前回复代际
 * 取消；代际失效或识别失败时条目保持原状，也不调用 onDescribed。返回的 Promise
 * 从不 reject。
 */
function describeBotImage(
  target: BotImageTarget,
  onDescribed: ((description: string) => void) | undefined
): Promise<void> {
  const { chatId, fileId, fileUniqueId }: BotImageTarget = target;
  const generation: number = cachedReplyGeneration(chatId);
  const task: Promise<void> = describeMedia({
    kind: "photo",
    fileId,
    fileUniqueId,
    voiceMime: undefined,
    voiceDurationSeconds: 0,
    signal: replyGenerationSignal(chatId, generation),
  }).then((description: string | null): void => {
    if (description === null || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    fillBotImage(target, description);
    onDescribed?.(description);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return task;
}

/**
 * 命令与定时任务发出的图片：以机器人身份写一条占位态条目，不识图。
 * edited 为 true（/wed 换图）时只把仍在热区的原条目重置为占位态，不新增条目。
 */
export function recordBotImage(msg: AiRecordBotImageMessage): void {
  const self: AiBotInfo | null = botInfoState.current;
  if (self === null) return;
  const caption: string = sanitizeInline(msg.caption);
  const text: string = botImageText("command", "", caption);
  if (msg.edited) {
    const entry: BufferedMessage | undefined = lookupBufferedMessage(msg.chatId, msg.messageId);
    if (entry?.id !== self.id) return;
    entry.text = text;
    entry.pendingImage = { origin: "command", caption };
    dirtyMemoryChats.add(msg.chatId);
    return;
  }
  const entry: BufferedMessage | null = buildBufferedMessage(
    buildSelfRecordMessage({ chatId: msg.chatId, self, messageId: msg.messageId, text }),
    text
  );
  if (entry === null) return;
  entry.pendingImage = { origin: "command", caption };
  pushBufferedMessage(msg.chatId, entry);
}

/** trackGeneratedImage 的入参。 */
export interface TrackGeneratedImageParams {
  chatId: number;
  /** 刚写入热区、带生图记号与提示词的自录条目。 */
  entry: BufferedMessage;
  origin: Exclude<BotImageOrigin, "command">;
  /** 随图发出的图注；没有图注为空串。 */
  caption: string;
  /** Telegram 为这张图返回的视觉源。 */
  photo: TelegramVisionSource;
}

/** 生图落地后：把自录条目标成占位态并立即识图，完成后原位换成画面内容。 */
export function trackGeneratedImage({ chatId, entry, origin, caption, photo }: TrackGeneratedImageParams): void {
  const pending: PendingBotImage = { origin, caption: sanitizeInline(caption) };
  entry.pendingImage = pending;
  void describeBotImage(
    { chatId, messageId: entry.messageId, fileId: photo.fileId, fileUniqueId: photo.fileUniqueId, pending },
    undefined
  );
}

/** 按身份摘除一项登记，内层表空时连外层键一并删除。 */
function forgetRepliedBotImage(chatId: number, messageId: number, task: Promise<void>): void {
  const byMessage: Map<number, Promise<void>> | undefined = repliedBotImageBackfills.get(chatId);
  if (byMessage?.get(messageId) !== task) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) repliedBotImageBackfills.delete(chatId);
}

/**
 * 记录一条回复了机器人图片的消息后调用：把回复引用的正文换成那张图的画面内容。
 *
 * 被回复的图仍在热区且已是内容态时同步复制正文；仍是占位态或已滑出热区时识图，
 * 完成后回填原条目（若仍在热区）与本条回复引用，并登记到 repliedBotImageBackfills
 * 供回复轮等待。原条目已是内容态时回复引用复制它的正文，否则按命令图记号拼
 * 描述与原图注。识图失败时回复引用保留主线程给的类型占位。
 */
export function resolveRepliedBotImage(chatId: number, entry: BufferedMessage, image: RepliedBotImage): void {
  const replyTo: BufferedReplyReference | undefined = entry.replyTo;
  if (replyTo === undefined) return;
  const target: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyTo.messageId);
  if (target !== undefined && target.pendingImage === undefined) {
    replyTo.text = truncateInline(target.text, REPLY_REFERENCE_MAX_CHARS);
    return;
  }
  const task: Promise<void> = describeBotImage(
    {
      chatId,
      messageId: replyTo.messageId,
      fileId: image.fileId,
      fileUniqueId: image.fileUniqueId,
      pending: target?.pendingImage,
    },
    (description: string): void => {
      const filled: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyTo.messageId);
      replyTo.text = truncateInline(
        filled !== undefined && filled.pendingImage === undefined
          ? filled.text
          : botImageText("command", description, sanitizeInline(image.caption)),
        REPLY_REFERENCE_MAX_CHARS
      );
      dirtyMemoryChats.add(chatId);
    }
  );
  let byMessage: Map<number, Promise<void>> | undefined = repliedBotImageBackfills.get(chatId);
  if (byMessage === undefined) {
    byMessage = new Map<number, Promise<void>>();
    repliedBotImageBackfills.set(chatId, byMessage);
  }
  byMessage.set(entry.messageId, task);
  void task.finally((): void => forgetRepliedBotImage(chatId, entry.messageId, task));
}

/** 回复轮拼提示词前要等待的回填；这条触发消息没有在途识图时为 undefined。 */
export function repliedBotImageBackfill(chatId: number, messageId: number): Promise<void> | undefined {
  return repliedBotImageBackfills.get(chatId)?.get(messageId);
}
