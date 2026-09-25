import { DISABLED_LINK_PREVIEW, MESSAGE_NOT_MODIFIED } from "../../../consts/telegram";
import type {
  InlineKeyboardMarkup,
  LinkPreviewOptions,
  Message,
  MessageEntity,
} from "grammy/types";
import { telegramApi } from "../client";
import { telegramErrorDetails } from "../errors";
import {
  logUnlessAborted,
  replyParametersFor,
  runBooleanTelegramAction,
  runTelegramAction,
} from "./core";
import { signalArgs } from "../../../libs/telegramSignalArgs";
import type {
  TelegramChatAction,
  TelegramSendResult,
} from "../../../types/telegram";
import type { TelegramApi } from "../../../types/telegramWorker";
import { toTelegramSendResult } from "./sendResult";

type SendMessageApi = Pick<TelegramApi, "sendMessage">;
type EditMessageTextApi = Pick<TelegramApi, "editMessageText">;
type SendChatActionApi = Pick<TelegramApi, "sendChatAction">;
type AnswerCallbackQueryApi = Pick<TelegramApi, "answerCallbackQuery">;

export interface SendMessageParams {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  api?: SendMessageApi;
  keyboard?: InlineKeyboardMarkup;
  signal?: AbortSignal;
  /** 由调用方自行算好偏移的富文本实体，见 sendMessageWithResult 的说明。 */
  entities?: readonly MessageEntity[];
  /** 是否关闭 Telegram 为正文中第一个 URL 自动生成的预览卡片。 */
  disableLinkPreview?: boolean;
  /** 原样沿用的链接预览设置（复读、翻译照搬原消息的预览）；给出时优先于 disableLinkPreview。 */
  linkPreviewOptions?: LinkPreviewOptions;
  /**
   * 论坛（topics）群里这条消息要落进哪个话题。
   *
   * 不传就是 General——Bot API 里「没有 message_thread_id」和「General」是同一件事。
   * 因此话题群里任何**不挂回复**的主动发送都必须显式带上它，否则一律掉进 General
   * （见 libs/forumTopic.ts）。挂了回复也不等于安全：`allow_sending_without_reply`
   * 会在目标已被删除时把这条降级成普通发送，那时只有这个参数还留在话题里。
   *
   * **用户命令与交互触发的消息落在触发消息所在的话题**（`AGENTS.md`「Telegram
   * 提示留存」）：
   * - 会话性输出、长期保留例外与按钮消息由调用方显式传入；`preserveInGroup`
   *   那一档由 `bun run check:conventions` 强制。
   * - 30 秒自删的命令提示省略时由 commandMessages.ts / commandPhotos.ts 按当前
   *   update 的触发话题补齐（infra/updateContext.ts 的 updateTopicThreadIdFor）；
   *   脱离 update 作用域的回执（头像更新、AI 限频提示、gag 结束回执）显式带上。
   * - bot 主动发出的提示不带：刷屏禁言公告、广告警告与封禁播报、入群验证提醒
   *   （另见 libs/forumTopic.ts 的豁免）、私密模式公告与 cron 定时任务。
   */
  messageThreadId?: number;
  /** 消息 id 的同步登记点，语义见 SendEphemeralMessageParams.onSent。 */
  onSent?: (messageId: number) => void;
}

/**
 * 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。
 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = telegramApi,
  keyboard,
  signal,
  entities,
  disableLinkPreview,
  linkPreviewOptions,
  messageThreadId,
  onSent,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.TextMessage> => {
      // 定形一次初始化：字段齐、顺序固定，缺席用 undefined 表达。条件展开会为
      // 每个可选字段造一个一次性 {} 并让同一个 payload 类型长出 2^5 种 shape，
      // 而 grammY 两条序列化路径都丢弃 undefined，产出的请求体逐字节相同
      // （对拍见 test/infra/telegramSendPayload.test.ts）。
      const other: Parameters<SendMessageApi["sendMessage"]>[2] = {
        message_thread_id: messageThreadId,
        reply_parameters: replyParametersFor(replyToMessageId),
        reply_markup: keyboard,
        entities: entities && entities.length > 0 ? [...entities] : undefined,
        link_preview_options: linkPreviewOptions ?? (disableLinkPreview ? DISABLED_LINK_PREVIEW : undefined),
      };
      return api.sendMessage(
        chatId,
        text,
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (
      sent: Message.TextMessage
    ): TelegramSendResult | undefined => {
      const result: TelegramSendResult = toTelegramSendResult(chatId, sent);
      onSent?.(result.messageId);
      return result;
    },
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

/** 发送纯文本消息，只返回 Telegram message_id。 */
export async function sendMessage(
  params: SendMessageParams
): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export interface SendEphemeralMessageParams {
  chatId: number;
  receiverUserId: number;
  callbackQueryId?: string;
  text: string;
  keyboard: InlineKeyboardMarkup;
  api?: SendMessageApi;
  signal?: AbortSignal;
  /**
   * 论坛（topics）群里这条目标专属提示要亮在哪个话题；语义见 SendMessageParams
   * 的同名字段。gag 的发言入口靠它跟着被管教的人换话题（见 commands/gag/）。
   */
  messageThreadId?: number;
  /**
   * 消息 id 的**同步**登记点：拿到 id 的那一刻立即回调，早于 runTelegramAction
   * 在发送成功之后补做的 update 取消判定（见 actions/core.ts）。
   *
   * 用于这一种情形：停机时 `runner.abortActive()` 可能恰好落在「远端已经
   * 收下这条消息、handler 还没走到下一行」的窗口里，此时 await 会以 AbortError
   * 解开，返回值连同 message id 一起丢失——发出去的提示从此没有任何人知道它的
   * id，状态机再也删不掉它。用它把 id 落进自己的状态，再让取消照常向上抛。
   * 回调必须是同步且不抛的：它跑在错误边界内部，抛出会被折算成发送失败。
   */
  onSent?: (messageId: number) => void;
}

/**
 * 使用 SDK 的 ephemeral_message_parameters 发送目标专属消息。
 * 响应身份校验后交给业务状态机定向删除。
 */
export async function sendEphemeralMessage({
  chatId,
  receiverUserId,
  callbackQueryId,
  text,
  keyboard,
  api = telegramApi,
  signal,
  messageThreadId,
  onSent,
}: SendEphemeralMessageParams): Promise<number | undefined> {
  const other: Parameters<SendMessageApi["sendMessage"]>[2] = {
    message_thread_id: messageThreadId,
    ephemeral_message_parameters: {
      receiver_user_id: receiverUserId,
      callback_query_id: callbackQueryId,
    },
    reply_markup: keyboard,
  };
  return runTelegramAction({
    action: "send ephemeral message",
    execute: (requestSignal?: AbortSignal): ReturnType<TelegramApi["sendMessage"]> =>
      api.sendMessage(
        chatId,
        text,
        other,
        ...signalArgs(requestSignal)
      ),
    map: (sent: Message.TextMessage): number => {
      const ephemeralMessageId: number | undefined =
        sent.ephemeral_message_id;
      if (
        sent.message_id !== 0 ||
        sent.chat.id !== chatId ||
        sent.receiver_user?.id !== receiverUserId ||
        ephemeralMessageId === undefined ||
        !Number.isSafeInteger(ephemeralMessageId) ||
        ephemeralMessageId <= 0
      ) {
        throw new Error("Telegram returned an invalid ephemeral message identity.");
      }
      onSent?.(ephemeralMessageId);
      return ephemeralMessageId;
    },
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

export interface SendChatActionParams {
  chatId: number;
  /** 要显示的状态；取值由 TelegramChatAction 单点定义。 */
  action: TelegramChatAction;
  api?: SendChatActionApi;
  signal?: AbortSignal;
  /**
   * 论坛（topics）群里这次状态要亮在哪个话题；语义见 SendMessageParams
   * 的同名字段。不传就亮在 General——消息落在话题里、「正在输入…」却亮在
   * General，是话题群里最容易被看见的那种不一致（见 libs/forumTopic.ts）。
   */
  messageThreadId?: number;
}

/** 发一次聊天状态（「正在输入…」这类）。 */
export async function sendChatAction({
  chatId,
  action,
  api = telegramApi,
  signal,
  messageThreadId,
}: SendChatActionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    `send ${action} action`,
    (requestSignal?: AbortSignal): Promise<true> =>
      api.sendChatAction(
        chatId,
        action,
        { message_thread_id: messageThreadId },
        ...signalArgs(requestSignal)
      ),
    signal
  );
}

/** 这次拒绝是否就是「内容本就相同」。 */
export function isMessageNotModified(error: unknown): boolean {
  return telegramErrorDetails(error)?.description.includes(MESSAGE_NOT_MODIFIED) === true;
}

export interface EditMessageTextParams {
  chatId: number;
  messageId: number;
  text: string;
  api?: EditMessageTextApi;
  /** 由调用方自行算好偏移的富文本实体，语义同 SendMessageParams.entities。 */
  entities?: readonly MessageEntity[];
  /** 新的按钮；不传即**清空**原有按钮，翻页看板据此在只剩一页时收走翻页条。 */
  keyboard?: InlineKeyboardMarkup;
  signal?: AbortSignal;
}

/**
 * 就地改写一条已发出的文本消息；不设置 parse_mode，同 sendMessageWithResult。
 *
 * @returns 是否已让远端处于目标状态。内容本就相同时同样为 true——调用方要的是
 *   「这条消息现在显示的是这一页」，而不是「本次真的发生了改写」。
 */
export async function editMessageText({
  chatId,
  messageId,
  text,
  api = telegramApi,
  entities,
  keyboard,
  signal,
}: EditMessageTextParams): Promise<boolean> {
  // 「内容本就相同」在这里就地咽掉，不进错误边界：那样才既不记 API 错误、
  // 又对调用方报成功，而不必把结论从一个名叫 shouldLogError 的谓词里带出来。
  // 其余失败原样抛给统一边界，停机 abort 因此也照 runBooleanTelegramAction
  // 的既有口径不记错误。
  return runBooleanTelegramAction(
    "edit message text",
    async (requestSignal?: AbortSignal): Promise<true> => {
      try {
        await api.editMessageText(
          chatId,
          messageId,
          text,
          {
            entities: entities && entities.length > 0 ? [...entities] : undefined,
            reply_markup: keyboard ?? { inline_keyboard: [] },
          },
          ...signalArgs(requestSignal)
        );
      } catch (error: unknown) {
        if (!isMessageNotModified(error)) throw error;
      }
      return true;
    },
    signal
  );
}

export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  api?: AnswerCallbackQueryApi;
}

export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = telegramApi,
}: AnswerCallbackQueryParams): Promise<void> {
  return runTelegramAction({
    action: "answer callback query",
    execute: (signal?: AbortSignal): Promise<true> =>
      api.answerCallbackQuery(
        callbackQueryId,
        { text, show_alert: showAlert },
        ...signalArgs(signal)
      ),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}
