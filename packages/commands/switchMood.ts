import type { CommandContext, Context } from "grammy";
import { switchAiMood } from "../aiChat";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { sendMessage } from "../infra/telegram";
import { formatMockerLabel } from "../users/userLabel";
import { isSuperAdmin } from "./superAdminToggle";

/**
 * 处理 /switch_mood 指令：立即重抽本群 AI 的当前心情并回复结果。心情缓存
 * 在 AI Worker 线程内（cache/aiChat/mood.ts），主线程只 post 一条 switchMood
 * 请求、等 moodSwitched 回执单独带回新心情名（见 aiChat/index.ts 的 switchAiMood），
 * 回复固定从这里发出，不走 AI 回复流水线。仅 SUPER_ADMIN_USER_ID 本人可用，
 * 与 /ai_chat 同一批权限：其他人尝试只会被嘲讽，指令本身不会执行。
 */
export async function handleSwitchMoodCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!isSuperAdmin(ctx.from)) {
    await sendMessage({
      chatId,
      text: `就 ${formatMockerLabel(ctx.from)} 也想给本天才换心情？本天才的心情才轮不到杂鱼做主呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  if (getChatState(chatId).isAIChatEnabled !== true) {
    await sendMessage({
      chatId,
      text: `本群连 AI 闲聊都没开，本天才在这儿根本没有心情可换呀，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  let moodName: string;
  try {
    moodName = await switchAiMood(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to confirm AI mood switch for chat ${chatId}:`, error);
    await sendMessage({
      chatId,
      text: `呜……本天才的 AI 脑袋没及时回话，这次没确认到新心情，过会儿再试吧♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  // Worker 已明确回执成功后，Telegram 发送失败属于消息投递错误，不能再
  // 伪装成重抽失败；让 grammY 的统一错误边界按 update 失败处理。
  await sendMessage({
    chatId,
    text: `哼，那就依你重抽一次——本天才现在的心情是「${moodName}」♡`,
    replyToMessageId: messageId,
  });
}
