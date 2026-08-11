import {
  deleteEphemeralMessageWithOutcome,
  deleteMessageWithOutcome,
  sendEphemeralMessage,
  sendMessage,
} from "../../infra/telegram";
import type { DeleteMessageOutcome } from "../../infra/telegram";
import type { GagSession } from "../../types/gag";
import {
  buildGagSpeakKeyboard,
  renderGagSpeakNotice,
} from "./rendering";

/** 主线程 gag 发言入口的 Telegram 动作边界；不持有会话缓存。 */

export interface SendGagSpeakNoticeOptions {
  readonly session: GagSession;
  /** 仅频道公开入口可回复原命令；用户临时入口没有普通 message_id。 */
  readonly replyToMessageId?: number;
  /** 远端返回 id 后同步登记，关闭停机 abort 丢失身份的窗口。 */
  readonly onSent?: (messageId: number) => void;
}

/** 按目标身份发送用户专属临时入口或频道公开入口。 */
export async function sendGagSpeakNotice({
  session,
  replyToMessageId,
  onSent,
}: SendGagSpeakNoticeOptions): Promise<number | undefined> {
  const text: string = renderGagSpeakNotice(session);
  const keyboard: ReturnType<typeof buildGagSpeakKeyboard> =
    buildGagSpeakKeyboard(session);
  if (session.targetId > 0) {
    return sendEphemeralMessage({
      chatId: session.chatId,
      receiverUserId: session.targetId,
      text,
      keyboard,
      onSent,
    });
  }
  return sendMessage({
    chatId: session.chatId,
    text,
    replyToMessageId,
    keyboard,
    onSent,
  });
}

/** 按入口身份精确删除；相同数字 id 在不同接收者之间不会互相串删。 */
export function deleteGagSpeakNotice(
  session: GagSession,
  noticeMessageId: number
): Promise<DeleteMessageOutcome> {
  if (session.targetId > 0) {
    return deleteEphemeralMessageWithOutcome({
      chatId: session.chatId,
      receiverUserId: session.targetId,
      ephemeralMessageId: noticeMessageId,
    });
  }
  return deleteMessageWithOutcome(session.chatId, noticeMessageId);
}
