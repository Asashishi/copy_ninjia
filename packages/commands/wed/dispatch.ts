import type { CommandContext, Context } from "grammy";
import { wedChats, wedRuntime } from "../../cache/main/wed";
import { WED_CALLBACK_PREFIX, WED_TEXTS } from "../../consts/wed";
import { answerCallbackQuery, sendCommandMessage } from "../../infra/telegram";
import type { WedChat } from "../../types/wed";
import { handleWedCallback, handleWedCommand } from "../wed";
import { getOrCreateWedChat } from "./chats";
import { submitWedTask } from "./runtime";

/** 纯内存 /wed 在接纳后释放 update；完整交互由主线程执行器及其停机边界持有。 */
export function dispatchWedCommand(ctx: CommandContext<Context>): void | Promise<void> {
  if (wedRuntime.current?.accepting !== true) return;
  if ((ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") || ctx.msg.sender_chat !== undefined) return handleWedCommand(ctx);
  const chat: WedChat | undefined = getOrCreateWedChat(ctx.chat.id);
  if (chat !== undefined && submitWedTask(chat, (): Promise<void> => handleWedCommand(ctx))) return;
  return sendCommandMessage({ chatId: ctx.chat.id,
    text: chat === undefined ? WED_TEXTS.full : WED_TEXTS.queueFull, replyToMessageId: ctx.msgId }).then((): void => undefined);
}

/** /wed 按钮与命令共享执行槽；出队后重新核对消息、目标及发起人身份。 */
export function dispatchWedCallback(ctx: Context): boolean | Promise<boolean> {
  const query: Context["callbackQuery"] = ctx.callbackQuery;
  if (!query?.data?.startsWith(WED_CALLBACK_PREFIX)) return false;
  if (wedRuntime.current?.accepting !== true) return true;
  const chat: WedChat | undefined = query.message === undefined ? undefined : wedChats.get(query.message.chat.id);
  if (chat === undefined) return handleWedCallback(ctx);
  if (submitWedTask(chat, (): Promise<boolean> => handleWedCallback(ctx))) return true;
  return answerCallbackQuery({ callbackQueryId: query.id, text: WED_TEXTS.queueFull }).then((): boolean => true);
}
