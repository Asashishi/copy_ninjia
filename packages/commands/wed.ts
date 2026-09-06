import type { CommandContext, Context } from "grammy";
import type { CallbackQuery, User } from "grammy/types";
import { wedChats } from "../cache/main/wed";
import { WED_CALLBACK_PREFIX, WED_OPERATION_TIMEOUT_MS, WED_SESSION_LIMIT, WED_TEXTS } from "../consts/wed";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { answerCallbackQuery, sendCommandMessage } from "../infra/telegram";
import { combineWithUpdateAbortSignal } from "../infra/updateContext";
import { forumTopicThreadId } from "../libs/forumTopic";
import type { WedCandidate, WedChat, WedSession } from "../types/wed";
import { drawWedCandidate } from "./wed/draw";
import { getOrCreateWedChat, teardownWedChat } from "./wed/chats";
import { confirmWedResult, removeWedResult, replaceWedResult, sendWedResult } from "./wed/messages";

/** 单次交互同时服从群 teardown、update 取消与总耗时限制。 */
function operationSignal(session: WedSession): AbortSignal {
  return combineWithUpdateAbortSignal(AbortSignal.any([
    session.controller.signal,
    AbortSignal.timeout(WED_OPERATION_TIMEOUT_MS),
  ]))!;
}

/** 群关闭先同步关闸，再删除状态机拥有的结果；重启不恢复这些会话。 */
export async function teardownWedInChat(chatId: number): Promise<void> {
  const chat: WedChat | undefined = wedChats.peek(chatId);
  if (chat === undefined) return;
  wedChats.delete(chatId);
  await teardownWedChat(chat);
}

/** 每位用户在群里保留一张结果；重复命令重新抽取并回复新命令。 */
export async function handleWedCommand(ctx: CommandContext<Context>): Promise<void> {
  const actor: User | undefined = ctx.from;
  if ((ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") ||
    ctx.msg.sender_chat !== undefined || actor === undefined || actor.is_bot) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: WED_TEXTS.groupOnly, replyToMessageId: ctx.msgId });
    return;
  }
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: WED_TEXTS.usage, replyToMessageId: ctx.msgId });
    return;
  }
  const chat: WedChat | undefined = getOrCreateWedChat(ctx.chat.id);
  const previous: WedSession | undefined = chat?.sessions.get(actor.id);
  const rejected: string | undefined = previous?.busy ? WED_TEXTS.busy
    : chat === undefined || (previous === undefined && chat.sessions.size >= WED_SESSION_LIMIT) ? WED_TEXTS.full
    : chat.members.size === 0 || (chat.members.size === 1 && chat.members.has(actor.id)) ? WED_TEXTS.empty
    : undefined;
  if (rejected !== undefined || chat === undefined) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: rejected ?? WED_TEXTS.full, replyToMessageId: ctx.msgId });
    return;
  }
  const session: WedSession = {
    chatId: ctx.chat.id,
    actor,
    messageThreadId: forumTopicThreadId(ctx.msg),
    controller: new AbortController(),
    messageId: undefined,
    targetId: undefined,
    confirmed: false,
    busy: true,
  };
  chat.sessions.set(session.actor.id, session);
  let replacedPrevious: boolean = previous === undefined;
  try {
    const signal: AbortSignal = operationSignal(session);
    const candidate: WedCandidate | undefined = await drawWedCandidate(session, chat, signal);
    if (session.controller.signal.aborted) return;
    if (candidate === undefined) {
      await sendCommandMessage({ chatId: session.chatId, text: WED_TEXTS.unavailable, replyToMessageId: ctx.msgId });
      return;
    }
    if (previous !== undefined) {
      if (!await removeWedResult(previous)) {
        await sendCommandMessage({ chatId: session.chatId, text: WED_TEXTS.failed, replyToMessageId: ctx.msgId });
        return;
      }
      previous.controller.abort();
      replacedPrevious = true;
    }
    if (signal.aborted) return;
    if (!await sendWedResult({ session, candidate, replyToMessageId: ctx.msgId, signal })) {
      await sendCommandMessage({ chatId: session.chatId, text: WED_TEXTS.failed, replyToMessageId: ctx.msgId });
    }
  } finally {
    session.busy = false;
    if (session.controller.signal.aborted) {
      await removeWedResult(session);
      if (previous !== undefined) await removeWedResult(previous);
    } else if (session.messageId === undefined) {
      if (previous !== undefined && !replacedPrevious) chat.sessions.set(session.actor.id, previous);
      else chat.sessions.delete(session.actor.id);
    }
  }
}

/** 认领 /wed 回调，校验群、消息、发起人和当前目标；耗时操作前先应答按钮。 */
export async function handleWedCallback(ctx: Context): Promise<boolean> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  if (!query?.data?.startsWith(WED_CALLBACK_PREFIX)) return false;
  const parts: string[] = query.data.slice(WED_CALLBACK_PREFIX.length).split(":");
  const actorId: number = Number(parts[0]);
  const targetId: number = Number(parts[1]);
  const action: string | undefined = parts[2];
  const message: CallbackQuery["message"] = query.message;
  const chat: WedChat | undefined = message === undefined ? undefined : wedChats.get(message.chat.id);
  const session: WedSession | undefined = chat?.sessions.get(actorId);
  const rejected: string | undefined = parts.length !== 3 || !Number.isSafeInteger(actorId) || actorId <= 0 ||
    !Number.isSafeInteger(targetId) || targetId <= 0 ||
    (action !== "remove" && action !== "marry" && action !== "change") ||
    message === undefined || message.date === 0 || session?.messageId !== message.message_id
    ? WED_TEXTS.expired : query.from.id !== session.actor.id ? WED_TEXTS.ownerOnly
    : session.targetId !== targetId ? WED_TEXTS.updated
    : session.busy ? WED_TEXTS.busy : undefined;
  if (rejected !== undefined || session === undefined || chat === undefined) {
    await answerCallbackQuery({ callbackQueryId: query.id, text: rejected ?? WED_TEXTS.expired });
    return true;
  }
  session.busy = true;
  try {
    const signal: AbortSignal = operationSignal(session);
    await answerCallbackQuery({ callbackQueryId: query.id,
      text: action === "marry" && session.confirmed ? WED_TEXTS.confirmed : undefined });
    if (signal.aborted) return true;
    let succeeded: boolean;
    if (action === "remove") {
      succeeded = await removeWedResult(session);
      if (succeeded) {
        chat.sessions.delete(session.actor.id);
        session.controller.abort();
      }
    } else if (action === "marry") {
      if (session.confirmed) return true;
      succeeded = await confirmWedResult(session, signal);
    } else {
      const candidate: WedCandidate | undefined = await drawWedCandidate(session, chat, signal);
      if (session.controller.signal.aborted) return true;
      if (candidate === undefined) {
        await sendCommandMessage({ chatId: session.chatId, text: WED_TEXTS.unavailable, replyToMessageId: session.messageId });
        return true;
      }
      succeeded = await replaceWedResult(session, candidate, signal);
    }
    if (!succeeded && !session.controller.signal.aborted) {
      await sendCommandMessage({ chatId: session.chatId, text: WED_TEXTS.failed, replyToMessageId: session.messageId });
    }
  } finally {
    session.busy = false;
    if (session.controller.signal.aborted) await removeWedResult(session);
  }
  return true;
}

registerChatTeardown("wed", teardownWedInChat);
