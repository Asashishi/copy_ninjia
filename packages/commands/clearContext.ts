import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import { invalidateAiChat } from "../aiChat";

import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import type { CachedUser } from "../types/chatState";
import { formatUserLabel } from "../users/userLabel";
import { isSuperAdminActor, resolveCommandActor } from "./commandActor";

/**
 * 处理 /clear_context：清空本群 AI 上下文记忆，从零重新累计。
 *
 * 清掉的是 AI Worker 里这个群的滚动逐字缓存、中期摘要、待晋升摘要与心情，以及
 * 磁盘上的 chat_states.ai_context——两件事由 aiChat/workerBridge.ts 的
 * invalidateAiChat(chatId, true) 一并完成，本命令不另写一条清理路径。同一次调用
 * 还会递增本群回复代数：在途那一轮的上下文此刻已经不存在，它的回复不该再发出去。
 *
 * **只认 SUPER_ADMIN_USER_ID 这个身份本身**（走 commandActor.ts 的 isSuperAdminActor，
 * 同 `/init`、`/batch_kick`），不挂任何白名单权限键，因此也无法经 `/permission`
 * 授权出去：这条命令一发就不可逆地抹掉本群全部 AI 上下文，磁盘上那份也一起没，
 * 误发没有任何补救途径。
 *
 * **前提不齐也照样执行**，口径同 `/ai_chat disable` 的关闭方向：部署配置写坏或
 * AI Worker 没起来时，磁盘上的记忆仍要能清干净，durable 删除本来就不经 Worker。
 *
 * 失败只回一句并记日志，绝不外抛：抛出去这条 update 就判失败，Telegram 会在重启
 * 后重投同一条命令，而那时 Worker 多半仍不可用，正好把重启循环焊死（同
 * commands/superAdminToggle.ts 的 runChatToggleCommand 对拆除失败的处理）。
 */
export async function handleClearContextCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (actor === undefined || !isSuperAdminActor(ctx)) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.clearContextRejected(actor === undefined ? chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.unknownActor : formatUserLabel(actor, chatAtmosphere(ctx.chat?.id ?? 0))),
      replyToMessageId: messageId,
    });
    return;
  }
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(ctx.chat?.id ?? 0).CLEAR_CONTEXT_USAGE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  try {
    await invalidateAiChat(chatId, true);
  } catch (error: unknown) {
    logger.error(`Failed to clear the AI chat context of chat ${chatId}:`, error);
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.clearContextFailed,
      replyToMessageId: messageId,
    });
    return;
  }

  await sendCommandMessage({
    chatId,
    text: chatAtmosphere(ctx.chat?.id ?? 0).NOTICE_TEXTS.clearContextDone,
    replyToMessageId: messageId,
  });
}
