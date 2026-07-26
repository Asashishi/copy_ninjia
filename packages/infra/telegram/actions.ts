import { InputFile } from "grammy";
import type { Api, InlineKeyboard } from "grammy";
import type { Message, MessageEntity, ReactionTypeEmoji, ChatMember, MessageId } from "@grammyjs/types";
import { markSelfSent } from "../selfSentTracker";
import {
  combineWithUpdateAbortSignal,
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../updateContext";
import { bot, logApiError } from "./client";
import type { TelegramSendResult } from "../../types/telegram";

interface RunTelegramActionParams<T, R> {
  action: string;
  execute: (signal?: AbortSignal) => Promise<T>;
  map: (result: T) => R;
  fallback: R;
  signal?: AbortSignal;
  shouldLogError?: (error: unknown) => boolean;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也留在同一个错误
 * 边界内，保持既有语义：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。这里不用 grammY 的 bot.catch：它处理的是
 * update/middleware 逃逸异常，且本项目会让该错误触发 update 重投；这些主动
 * API 调用失败属于可预期的业务结果，调用方还需要得到 false/undefined。
 */
async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  signal,
  shouldLogError,
}: RunTelegramActionParams<T, R>): Promise<R> {
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  const actionSignal: AbortSignal | undefined = combineWithUpdateAbortSignal(signal);
  throwIfUpdateAborted(updateSignal);
  try {
    const mapped: R = map(await execute(actionSignal));
    // 远端可能在 abort 竞态中已经提交成功；先做 map 中最小的 self-sent
    // 记账，再把 update 取消向上抛出，禁止 handler 继续后续业务写入。
    throwIfUpdateAborted(updateSignal);
    return mapped;
  } catch (error: unknown) {
    if (updateSignal?.aborted === true) {
      throwIfUpdateAborted(updateSignal);
    }
    if (shouldLogError?.(error) !== false) logApiError(action, error);
    return fallback;
  }
}

/**
 * 把一条已发出的消息收敛成 TelegramSendResult：登记进自发消息表（供自动流水线
 * 识别频道自回环，见 infra/selfSentTracker.ts），并带回 Telegram 实际建立的回复
 * 关系。发消息与发图片共用，两者不得各写一份。
 */
function toSendResult(chatId: number, sent: Message): TelegramSendResult {
  markSelfSent(chatId, sent.message_id);
  return {
    messageId: sent.message_id,
    ...(sent.reply_to_message ? { repliedToMessageId: sent.reply_to_message.message_id } : {}),
  };
}

/** 执行只关心是否成功的 Telegram 动作。 */
async function runBooleanTelegramAction(
  action: string,
  execute: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  return runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (): boolean => combineWithUpdateAbortSignal(signal)?.aborted !== true,
  });
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  api?: Api;
  keyboard?: InlineKeyboard;
  signal?: AbortSignal;
  /** 由调用方自行算好偏移的富文本实体，见 sendMessageWithResult 的说明。 */
  entities?: readonly MessageEntity[];
  /**
   * 关闭 Telegram 为正文里第一个 URL 自动生成的预览卡片。挂 text_link 实体
   * 指向 t.me 主页时必须置真：一行动作回复底下跟一整块「Telegram: Contact
   * @xxx」预览卡是噪音，发起人是频道马甲时还会变成「加入频道」邀请卡。
   * 运势 inline 结果同样显式禁用（见 commands/luckChallenge/rendering.ts）。
   */
  disableLinkPreview?: boolean;
}

/** 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。确实需要链接/格式时，由调用方显式传入
 * entities：偏移按 Telegram 的 UTF-16 code unit 口径逐段算好，昵称等用户内容
 * 只作为纯文本参与拼接，不会被解析成标记。 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = bot.api,
  keyboard,
  signal,
  entities,
  disableLinkPreview,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (requestSignal?: AbortSignal): Promise<Message.TextMessage> => {
      const other: Parameters<Api["sendMessage"]>[2] = {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(entities && entities.length > 0 ? { entities: [...entities] } : {}),
        ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
      };
      return requestSignal === undefined
        ? api.sendMessage(chatId, text, other)
        : api.sendMessage(
          chatId,
          text,
          other,
          requestSignal as unknown as Parameters<Api["sendMessage"]>[3]
        );
    },
    map: (sent: Message.TextMessage): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (): boolean => combineWithUpdateAbortSignal(signal)?.aborted !== true,
  });
}

/** 发送纯文本消息的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendMessage(params: SendMessageParams): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export async function sendTypingAction(
  chatId: number,
  api: Api = bot.api,
  signal?: AbortSignal
): Promise<boolean> {
  return runBooleanTelegramAction(
    "send typing action",
    (requestSignal?: AbortSignal): Promise<true> => requestSignal === undefined
      ? api.sendChatAction(chatId, "typing")
      : api.sendChatAction(
        chatId,
        "typing",
        {},
        requestSignal as unknown as Parameters<Api["sendChatAction"]>[3]
      ),
    signal
  );
}

export async function sendUploadPhotoAction(
  chatId: number,
  api: Api = bot.api,
  signal?: AbortSignal
): Promise<boolean> {
  return runBooleanTelegramAction(
    "send upload photo action",
    (requestSignal?: AbortSignal): Promise<true> => requestSignal === undefined
      ? api.sendChatAction(chatId, "upload_photo")
      : api.sendChatAction(
        chatId,
        "upload_photo",
        {},
        requestSignal as unknown as Parameters<Api["sendChatAction"]>[3]
      ),
    signal
  );
}

export async function sendChooseStickerAction(
  chatId: number,
  api: Api = bot.api,
  signal?: AbortSignal
): Promise<boolean> {
  return runBooleanTelegramAction(
    "send choose sticker action",
    (requestSignal?: AbortSignal): Promise<true> => requestSignal === undefined
      ? api.sendChatAction(chatId, "choose_sticker")
      : api.sendChatAction(
        chatId,
        "choose_sticker",
        {},
        requestSignal as unknown as Parameters<Api["sendChatAction"]>[3]
      ),
    signal
  );
}

export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  api?: Api;
}

export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = bot.api,
}: AnswerCallbackQueryParams): Promise<void> {
  return runTelegramAction({
    action: "answer callback query",
    execute: (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert })
      : api.answerCallbackQuery(
        callbackQueryId,
        { text, show_alert: showAlert },
        signal as unknown as Parameters<Api["answerCallbackQuery"]>[2]
      ),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}

export interface SendStickerParams {
  chatId: number;
  fileId: string;
  api?: Api;
  signal?: AbortSignal;
}

export async function sendSticker({
  chatId,
  fileId,
  api = bot.api,
  signal,
}: SendStickerParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: (requestSignal?: AbortSignal): Promise<Message.StickerMessage> => requestSignal === undefined
      ? api.sendSticker(chatId, fileId)
      : api.sendSticker(
        chatId,
        fileId,
        {},
        requestSignal as unknown as Parameters<Api["sendSticker"]>[3]
      ),
    map: (sent: Message.StickerMessage): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    shouldLogError: (): boolean => combineWithUpdateAbortSignal(signal)?.aborted !== true,
  });
}

export interface SendPhotoParams {
  chatId: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: Api;
  signal?: AbortSignal;
}

/** 从内存上传一张图片并返回 Telegram 实际建立的回复关系；不落临时文件。 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = bot.api,
  signal,
}: SendPhotoParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async (requestSignal?: AbortSignal): Promise<Message.PhotoMessage> => {
      const extension: string = mimeType === "image/jpeg" ? "jpg" : "png";
      const other: Parameters<Api["sendPhoto"]>[2] = {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      };
      return requestSignal === undefined
        ? api.sendPhoto(chatId, new InputFile(bytes, `generated.${extension}`), other)
        : api.sendPhoto(
          chatId,
          new InputFile(bytes, `generated.${extension}`),
          other,
          requestSignal as unknown as Parameters<Api["sendPhoto"]>[3]
        );
    },
    map: (sent: Message.PhotoMessage): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (): boolean => combineWithUpdateAbortSignal(signal)?.aborted !== true,
  });
}

/** 上传图片的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendPhoto(params: SendPhotoParams): Promise<number | undefined> {
  return (await sendPhotoWithResult(params))?.messageId;
}

export interface SetMessageReactionParams {
  chatId: number;
  messageId: number;
  emoji: string;
  api?: Api;
  signal?: AbortSignal;
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。 */
export async function setMessageReaction({
  chatId,
  messageId,
  emoji,
  api = bot.api,
  signal,
}: SetMessageReactionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    (requestSignal?: AbortSignal): Promise<true> => requestSignal === undefined
      ? api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }])
      : api.setMessageReaction(
        chatId,
        messageId,
        [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }],
        {},
        requestSignal as unknown as Parameters<Api["setMessageReaction"]>[4]
      ),
    signal
  );
}

export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    "delete message",
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.deleteMessage(chatId, messageId)
      : api.deleteMessage(
        chatId,
        messageId,
        signal as unknown as Parameters<Api["deleteMessage"]>[2]
      )
  );
}

export interface DeleteMessageAfterParams {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: Api;
}

/** 延迟删除用于公告清理，不让这类美化任务阻止进程退出。 */
export function deleteMessageAfter({ chatId, messageId, delayMs, api = bot.api }: DeleteMessageAfterParams): void {
  setTimeout((): void => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}

/** 原子地将成员移出群聊但不加入封禁名单。 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `kick chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.unbanChatMember(chatId, userId)
      : api.unbanChatMember(
        chatId,
        userId,
        {},
        signal as unknown as Parameters<Api["unbanChatMember"]>[3]
      )
  );
}

export async function banChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `ban chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.banChatMember(chatId, userId)
      : api.banChatMember(
        chatId,
        userId,
        {},
        signal as unknown as Parameters<Api["banChatMember"]>[3]
      )
  );
}

/**
 * 解除某人在这个群的封禁。**`only_if_banned` 不能省**：Bot API 的
 * unbanChatMember 对「当前就是群成员」的人语义是把他移出群聊——上面那个
 * kickChatMember 正是靠这一点实现「只踢不封」的。不带这个标志去批量解封，
 * 会把那些本来好端端待在群里的人一个个踢出去。
 * @returns 调用成功为 true；本来就没被封禁也算成功（该标志下是 no-op）。
 */
export async function unbanChatMemberIfBanned(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.unbanChatMember(chatId, userId, { only_if_banned: true })
      : api.unbanChatMember(
        chatId,
        userId,
        { only_if_banned: true },
        signal as unknown as Parameters<Api["unbanChatMember"]>[3]
      )
  );
}

function isPresentMember(member: ChatMember): boolean {
  if (member.status === "restricted") return member.is_member;
  return member.status === "creator" || member.status === "administrator" || member.status === "member";
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runTelegramAction({
    action: `check chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> => signal === undefined
      ? api.getChatMember(chatId, userId)
      : api.getChatMember(
        chatId,
        userId,
        signal as unknown as Parameters<Api["getChatMember"]>[2]
      ),
    map: isPresentMember,
    fallback: false,
  });
}

/**
 * 同上，但把「确认不在群」与「查询失败」分开。isChatMember 那种 fail-closed
 * 的 boolean 适合战报措辞（没确认就不吹嘘已踢出），却不能用来决定要不要执行
 * 处置——一次 429 被当成「不在群」就等于静默放过一个该被清出去的人。
 * @returns 在群 true、确认不在群 false、查询失败 undefined（调用方自行决定
 *   未确认时的偏向）。
 */
export async function probeChatMembership(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> => signal === undefined
      ? api.getChatMember(chatId, userId)
      : api.getChatMember(
        chatId,
        userId,
        signal as unknown as Parameters<Api["getChatMember"]>[2]
      ),
    map: isPresentMember,
    fallback: undefined,
  });
}

export async function banChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `ban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.banChatSenderChat(chatId, senderChatId)
      : api.banChatSenderChat(
        chatId,
        senderChatId,
        signal as unknown as Parameters<Api["banChatSenderChat"]>[2]
      )
  );
}

/**
 * 解除某个频道马甲在这个群的发言封禁。频道身份没有「成员」这一说，因此不存在
 * unbanChatMember 那种「解封等于踢人」的陷阱，直接调即可。
 */
export async function unbanChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.unbanChatSenderChat(chatId, senderChatId)
      : api.unbanChatSenderChat(
        chatId,
        senderChatId,
        signal as unknown as Parameters<Api["unbanChatSenderChat"]>[2]
      )
  );
}

export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: (signal?: AbortSignal): Promise<MessageId> => signal === undefined
      ? bot.api.copyMessage(chatId, fromChatId, messageId)
      : bot.api.copyMessage(
        chatId,
        fromChatId,
        messageId,
        {},
        signal as unknown as Parameters<Api["copyMessage"]>[4]
      ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
