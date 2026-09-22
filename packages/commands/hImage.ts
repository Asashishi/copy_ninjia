/**
 * `/h_image`：不带参数时抽一张图（commands/hImage/draw.ts），`add` 把被回复消息里的图收进
 * 图库（commands/hImage/add.ts）；请求交给延迟命令执行器（commands/deferredCommands.ts），
 * 接纳后立即返回。
 *
 * 群是否已 `/init`、私聊是否放行由 infra/updateGate.ts 的前置网关统一判定，这里不再
 * 重复。用法与忙碌提示走 sendCommandMessage，30 秒后删除。
 *
 * 命令入口先过全局滑动窗口配额（tryConsumeHImageRateLimit），超额的那几次直接返回，
 * 不解析参数、不提交任务、也不回任何消息。
 */

import type { CommandContext, Context } from "grammy";
import {
  H_IMAGE_ADD_ARGUMENT,
  H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  H_IMAGE_RATE_LIMIT_WINDOW_MS,
} from "../consts/hImage";
import { recentHImageCallTimestamps } from "../cache/main/hImage";
import { chatAtmosphere } from "../infra/atmosphere";
import { sendCommandMessage } from "../infra/telegram";
import { forumTopicThreadId } from "../libs/forumTopic";
import { tryConsumeSlidingWindow } from "../libs/slidingWindowRateLimit";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { HImageRequest } from "../types/hImage";
import { submitDeferredCommand } from "./deferredCommands";
import { handleHImageAddCommand } from "./hImage/add";
import { deliverRandomImage } from "./hImage/draw";

/**
 * 全局滑动窗口配额：一张图就是一次图片上传，成本远高于普通文本应答，因此不分群、不分
 * 用户合并计数（窗口与上限见 consts/hImage.ts，队列见 cache/main/hImage.ts）。超额立即
 * 拒绝、不排队。
 * @param now 当前时刻；默认取墙钟，测试可注入固定值。
 * @returns 仍在配额内为 true，本次调用已记账；超额为 false。
 */
export function tryConsumeHImageRateLimit(now: number = Date.now()): boolean {
  return tryConsumeSlidingWindow({
    timestamps: recentHImageCallTimestamps,
    windowMs: H_IMAGE_RATE_LIMIT_WINDOW_MS,
    maxCalls: H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW,
    now,
  });
}

/** 处理 `/h_image` 与 `/h_image add`；其它参数回用法提示。抽图接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!tryConsumeHImageRateLimit()) return;
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(chatId).H_IMAGE_TEXTS;
  // 子命令词不区分大小写，口径同 `/copy`、`/qa`、`/icon`、`/translate`。
  const argument: string = ctx.match.trim().toLowerCase();
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
