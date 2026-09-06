import { InlineKeyboard } from "grammy";
import type { User } from "grammy/types";
import { WED_BUTTON_TEXTS, WED_CALLBACK_PREFIX, WED_NAME_MAX_CHARS } from "../../consts/wed";
import { truncateInline } from "../../libs/text";
import type { RichTextMessage } from "../../types/telegram";
import { formatFullName } from "../../users/userLabel";

/** 昵称作为纯文本拼接，实体偏移按 UTF-16 计算。 */
export function renderWedCaption(actor: User, target: User): RichTextMessage {
  const actorName: string = truncateInline(formatFullName(actor), WED_NAME_MAX_CHARS);
  const targetName: string = truncateInline(formatFullName(target), WED_NAME_MAX_CHARS);
  const prefix: string = `${actorName}，你的群友老婆是 `;
  return {
    text: `${prefix}${targetName}!`,
    entities: [
      { type: "text_mention", offset: 0, length: actorName.length, user: actor },
      { type: "text_mention", offset: prefix.length, length: targetName.length, user: target },
    ],
  };
}

/** 单排三按钮绑定发起人和当前目标，消息 ID 由 Telegram 回传。 */
export function buildWedKeyboard(actorId: number, targetId: number, confirmed: boolean = false): InlineKeyboard {
  return new InlineKeyboard()
    .text(WED_BUTTON_TEXTS.remove, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:remove`)
    .text(confirmed ? WED_BUTTON_TEXTS.confirmed : WED_BUTTON_TEXTS.marry, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:marry`)
    .text(WED_BUTTON_TEXTS.change, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:change`);
}
