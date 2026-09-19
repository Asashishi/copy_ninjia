/**
 * `/h_image`：不带参数时抽一张图（commands/hImage/draw.ts），`add` 把被回复消息里的图收进
 * 图库（commands/hImage/add.ts）；请求交给延迟命令执行器（commands/deferredCommands.ts），
 * 接纳后立即返回。
 *
 * 群是否已 `/init`、私聊是否放行由 infra/updateGate.ts 的前置网关统一判定，这里不再
 * 重复。用法与忙碌提示走 sendCommandMessage，30 秒后删除。
 */

import type { CommandContext, Context } from "grammy";
import { H_IMAGE_ADD_ARGUMENT } from "../consts/hImage";
import { chatAtmosphere } from "../infra/atmosphere";
import { sendCommandMessage } from "../infra/telegram";
import { forumTopicThreadId } from "../libs/forumTopic";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { HImageRequest } from "../types/hImage";
import { submitDeferredCommand } from "./deferredCommands";
import { handleHImageAddCommand } from "./hImage/add";
import { deliverRandomImage } from "./hImage/draw";

/** 处理 `/h_image` 与 `/h_image add`；其它参数回用法提示。抽图接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(chatId).H_IMAGE_TEXTS;
  const argument: string = ctx.match.trim();
  if (argument === H_IMAGE_ADD_ARGUMENT) {
    await handleHImageAddCommand(ctx);
    return;
  }
  if (argument.length > 0) {
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
