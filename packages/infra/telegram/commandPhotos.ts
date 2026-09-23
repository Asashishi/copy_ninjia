/**
 * 带图的命令回执：发送成功即登记统一的 30 秒延迟删除（群聊），私聊保持原样，与
 * commandMessages.ts 的 sendCommandMessage 同一语义。只在主线程使用：可复用的 file_id
 * 需要直接走主线程 grammY 客户端，不经 Worker 双工代理的能力面，因此不从
 * infra/telegram/index.ts 的统一出口导出。
 */

import { InputFile } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import { BOT_PROFILE_PHOTO_FILE_NAME } from "../../consts/telegram";
import { signalArgs } from "../../libs/telegramSignalArgs";
import { markSelfSent } from "../selfSentTracker";
import { logUnlessAborted, replyParametersFor, runTelegramAction } from "./actions/core";
import { deleteMessageAfter } from "./actions/messageLifecycle";
import { bot } from "./mainClient";
import { updateTopicThreadIdFor } from "../updateContext";

/** sendCommandPhoto 的入参。 */
export interface SendCommandPhotoParams {
  readonly chatId: number;
  /** 可复用的 file_id，或本次下载到的图片字节（上传后不得再读）。 */
  readonly photo: string | Uint8Array;
  /** 调用方须限制在 Telegram 图注上限内；不设 parse_mode。 */
  readonly caption: string;
  readonly captionEntities: readonly MessageEntity[];
  readonly replyToMessageId?: number;
  /**
   * 论坛群的话题标识；省略时沿用当前 update 触发消息所在的话题（仅限同群，见
   * infra/updateContext.ts 的 updateTopicThreadIdFor）。
   */
  readonly messageThreadId?: number;
  readonly signal?: AbortSignal;
}

/**
 * 发送一张带图注的命令回执。拿到 message id 的同一时刻登记自发消息与（群聊的）30 秒删除：
 * 远端成功后 update 即使随即被取消，已发出的回执也不会漏删；发送失败不创建删除任务。
 * @returns 已发送的 message id；失败时为 undefined（错误由统一动作边界记录）。
 */
export function sendCommandPhoto({
  chatId,
  photo,
  caption,
  captionEntities,
  replyToMessageId,
  messageThreadId,
  signal,
}: SendCommandPhotoParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send command photo",
    execute: (requestSignal?: AbortSignal): Promise<Message.PhotoMessage> => bot.api.sendPhoto(
      chatId,
      typeof photo === "string" ? photo : new InputFile(photo, BOT_PROFILE_PHOTO_FILE_NAME),
      {
        caption,
        caption_entities: captionEntities.length > 0 ? [...captionEntities] : undefined,
        reply_parameters: replyParametersFor(replyToMessageId),
        message_thread_id: messageThreadId ?? updateTopicThreadIdFor(chatId),
      },
      ...signalArgs(requestSignal)
    ),
    map: (sent: Message.PhotoMessage): number => {
      markSelfSent(chatId, sent.message_id);
      if (chatId < 0) deleteMessageAfter({ chatId, messageId: sent.message_id, delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS });
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}
