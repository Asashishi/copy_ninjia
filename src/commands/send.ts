import type { CommandContext, Context } from "grammy";
import { clearChatStateField, getActiveProxySendTarget, getOrCreateChatState, saveStateInBackground } from "../infra/storage";
import { bot, logApiError, sendMessage } from "../infra/telegram";
import { isSuperAdmin } from "./superAdminToggle";

/**
 * 隐藏的超管私聊中转命令；群聊和非超管调用静默拒绝。只接受可达的
 * group/supergroup，持久化位置由 ChatState.isUseProxySend 定义。
 */
export async function handleSendCommand(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type !== "private") return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!isSuperAdmin(ctx.from)) return;

  const arg: string = ctx.match.trim();
  const activeTargetChatId: number | undefined = getActiveProxySendTarget();

  if (arg.toLowerCase() === "finish") {
    if (activeTargetChatId === undefined) {
      await sendMessage(chatId, `现在又没在转发，是想 finish 什么呀♡`, messageId);
      return;
    }
    clearChatStateField(activeTargetChatId, "isUseProxySend");
    saveStateInBackground("send finished");
    await sendMessage(chatId, `好啦，不转发了♡`, messageId);
    return;
  }

  const targetChatId: number = Number(arg);
  if (!arg || !Number.isSafeInteger(targetChatId)) {
    await sendMessage(chatId, `笨蛋，要 /send <群组id> 或者 /send finish，说清楚呀♡`, messageId);
    return;
  }

  if (activeTargetChatId !== undefined) {
    await sendMessage(chatId, `已经在转发到 ${activeTargetChatId} 了，先 /send finish 呀♡`, messageId);
    return;
  }

  try {
    const targetChat = await bot.api.getChat(targetChatId);
    if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
      await sendMessage(chatId, `只能转发进群组呀，${targetChatId} 不是群组，检查一下 id♡`, messageId);
      return;
    }
  } catch (error: unknown) {
    logApiError(`resolve /send target chat ${targetChatId}`, error);
    await sendMessage(chatId, `连不上 ${targetChatId} 这个聊天呀，检查一下 id 对不对、本天才是不是已经在那边了♡`, messageId);
    return;
  }

  getOrCreateChatState(targetChatId).isUseProxySend = true;
  saveStateInBackground("send started");
  await sendMessage(chatId, `好，现在这里发的消息本天才都会转发进 ${targetChatId}，说完了记得 /send finish♡`, messageId);
}
