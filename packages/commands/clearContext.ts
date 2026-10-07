import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import { invalidateAiChat } from "../aiChat";

import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import type { CachedUser } from "../types/chatState";
import { rejectUnlessPermitted } from "./commandActor";

/**
 * 处理 /clear_context：清空本群 AI 上下文记忆，从零重新累计。
 *
 * 清掉 AI Worker 里这个群的运行时状态，以及磁盘上的 chat_states.ai_context；心情全局共用一份，
 * 不随单群清理。两部分由 aiChat/workerBridge.ts 的 invalidateAiChat(chatId) 一并完成，
 * 同一次调用还会使本群回复代数失效，在途回复不再发出。
 *
 * 发起身份必须持有 isCanClearContext；超级管理员由统一权限边界直授。
 * 只操作命令所在群，带参数时回复用法提示。
 *
 * 不检查部署配置与 AI Worker 状态，口径同 `/ai_chat disable` 的关闭方向。
 *
 * 清理失败只回一句失败回执并记日志，不外抛（同 commands/superAdminToggle.ts 的
 * runChatToggleCommand 对拆除失败的处理）。
 */
export async function handleClearContextCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanClearContext",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.clearContextRejected(actorLabel)
  );
  if (actor === undefined) return;
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().CLEAR_CONTEXT_USAGE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  try {
    await invalidateAiChat(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to clear the AI chat context of chat ${chatId}:`, error);
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().NOTICE_TEXTS.clearContextFailed,
      replyToMessageId: messageId,
    });
    return;
  }

  await sendCommandMessage({
    chatId,
    text: chatAtmosphere().NOTICE_TEXTS.clearContextDone,
    replyToMessageId: messageId,
  });
}
