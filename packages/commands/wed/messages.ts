/**
 * /wed 状态消息的唯一发送边界。可操作的图片结果只由移除、
 * 重开、LRU 淘汰和群 teardown 清理，不挂固定延迟删除。豁免登记于 conventions/telegramMessages。
 * 发送、取消和自发消息登记遵守 docs/cn/04-invariants.md 的 Telegram 出站约束。
 */
import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import { BOT_PROFILE_PHOTO_FILE_NAME } from "../../consts/telegram";
import { bot } from "../../infra/telegram/mainClient";
import { deleteMessageWithOutcome } from "../../infra/telegram";
import { markSelfSent } from "../../infra/selfSentTracker";
import {
  logUnlessAborted,
  replyParametersFor,
  runTelegramAction,
  signalArgs,
} from "../../infra/telegram/actions/core";
import { isMessageNotModified } from "../../infra/telegram/actions/messages";
import type { RichTextMessage } from "../../types/telegram";
import type { WedCandidate, WedSession } from "../../types/wed";
import { buildWedKeyboard, renderWedCaption } from "./rendering";

export interface SendWedResultOptions {
  readonly session: WedSession;
  readonly candidate: WedCandidate;
  readonly replyToMessageId: number;
  readonly signal: AbortSignal;
}

/** 按 file_id 复用头像或上传下载字节；远端成功时先同步登记消息 ID，再传播取消。 */
export function sendWedResult({ session, candidate, replyToMessageId, signal }: SendWedResultOptions): Promise<boolean> {
  const caption: RichTextMessage = renderWedCaption(session.actor, candidate.identity);
  return runTelegramAction({
    action: "send wed result",
    execute: (requestSignal?: AbortSignal): Promise<Message.PhotoMessage> => bot.api.sendPhoto(
      session.chatId,
      typeof candidate.photo === "string" ? candidate.photo : new InputFile(candidate.photo, BOT_PROFILE_PHOTO_FILE_NAME),
      {
        caption: caption.text,
        caption_entities: [...caption.entities],
        reply_markup: buildWedKeyboard(session.actor.id, candidate.identity.id),
        reply_parameters: replyParametersFor(replyToMessageId),
        message_thread_id: session.messageThreadId,
      },
      ...signalArgs(requestSignal)
    ),
    map: (sent: Message.PhotoMessage): boolean => {
      session.messageId = sent.message_id;
      session.targetId = candidate.identity.id;
      markSelfSent(session.chatId, sent.message_id);
      return true;
    },
    fallback: false,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

/** 在同一条消息中同时换头像、图注和按钮；失败时保留原抽取。 */
export function replaceWedResult(session: WedSession, candidate: WedCandidate, signal: AbortSignal): Promise<boolean> {
  const caption: RichTextMessage = renderWedCaption(session.actor, candidate.identity);
  return runTelegramAction({
    action: "replace wed result",
    execute: (requestSignal?: AbortSignal): ReturnType<typeof bot.api.editMessageMedia> => bot.api.editMessageMedia(
      session.chatId,
      session.messageId!,
      {
        type: "photo",
        media: typeof candidate.photo === "string" ? candidate.photo : new InputFile(candidate.photo, BOT_PROFILE_PHOTO_FILE_NAME),
        caption: caption.text,
        caption_entities: [...caption.entities],
      },
      { reply_markup: buildWedKeyboard(session.actor.id, candidate.identity.id) },
      ...signalArgs(requestSignal)
    ),
    map: (): boolean => {
      session.targetId = candidate.identity.id;
      session.confirmed = false;
      return true;
    },
    fallback: false,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

/** 确认只改变中间按钮，仍保留移除和更换入口。 */
export function confirmWedResult(session: WedSession, signal: AbortSignal): Promise<boolean> {
  return runTelegramAction({
    action: "confirm wed result",
    execute: async (requestSignal?: AbortSignal): Promise<void> => {
      try {
        await bot.api.editMessageReplyMarkup(session.chatId, session.messageId!, {
          reply_markup: buildWedKeyboard(session.actor.id, session.targetId!, true),
        }, ...signalArgs(requestSignal));
      } catch (error: unknown) {
        if (!isMessageNotModified(error)) throw error;
      }
    },
    map: (): boolean => {
      session.confirmed = true;
      return true;
    },
    fallback: false,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

/** 删除失败保留消息 ID 和会话，允许原发起人再次点击移除。 */
export async function removeWedResult(session: WedSession): Promise<boolean> {
  if (session.messageId === undefined) return true;
  const outcome: Awaited<ReturnType<typeof deleteMessageWithOutcome>> =
    await deleteMessageWithOutcome(session.chatId, session.messageId);
  if (outcome !== "deleted" && outcome !== "gone") return false;
  session.messageId = undefined;
  return true;
}
