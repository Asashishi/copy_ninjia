import type { Message } from "@grammyjs/types";

/** Telegram 消息是否承载用户主动发送的内容，而不是平台生成的服务事件。 */
export function hasUserMessageContent(message: Message): boolean {
  return message.text !== undefined ||
    message.rich_message !== undefined ||
    message.animation !== undefined ||
    message.audio !== undefined ||
    message.document !== undefined ||
    message.live_photo !== undefined ||
    message.paid_media !== undefined ||
    message.photo !== undefined ||
    message.sticker !== undefined ||
    message.story !== undefined ||
    message.video !== undefined ||
    message.video_note !== undefined ||
    message.voice !== undefined ||
    message.contact !== undefined ||
    message.dice !== undefined ||
    message.game !== undefined ||
    message.poll !== undefined ||
    message.venue !== undefined ||
    message.location !== undefined ||
    message.checklist !== undefined;
}
