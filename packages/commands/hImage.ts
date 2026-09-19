/**
 * `/h_image`：解析参数并把请求交给延迟命令执行器（commands/deferredCommands.ts），接纳后
 * 立即返回；抽图见 commands/hImage/draw.ts。
 *
 * 群是否已 `/init`、私聊是否放行由 infra/updateGate.ts 的前置网关统一判定，这里不再
 * 重复。用法与忙碌提示走 sendCommandMessage，30 秒后删除。
 */

import type { CommandContext, Context } from "grammy";
import { chatAtmosphere } from "../infra/atmosphere";
import { sendCommandMessage } from "../infra/telegram";
import { forumTopicThreadId } from "../libs/forumTopic";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { HImageRequest } from "../types/hImage";
import { submitDeferredCommand } from "./deferredCommands";
import { deliverRandomImage } from "./hImage/draw";

/** 处理 `/h_image`：不接受参数；接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(chatId).H_IMAGE_TEXTS;
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({ chatId, text: texts.usage, replyToMessageId: messageId });
    return;
  }
  const request: HImageRequest = { chatId, messageId, messageThreadId: forumTopicThreadId(ctx.msg) };
  const accepted: boolean = submitDeferredCommand(
    "interactive",
    (): Promise<void> => deliverRandomImage(request),
    "Unexpected error while processing /h_image request:"
  );
  if (!accepted) await sendCommandMessage({ chatId, text: texts.busy, replyToMessageId: messageId });
}
