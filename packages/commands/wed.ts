import type { CommandContext, Context } from "grammy";
import type { CallbackQuery, User } from "grammy/types";
import { wedChats } from "../cache/main/wed";
import { WED_CALLBACK_PREFIX, WED_OPERATION_TIMEOUT_MS, WED_SESSION_LIMIT, WED_TEXTS } from "../consts/wed";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { purgesChatData } from "../libs/chatTeardown";
import { isTimeoutAbort, signalWithTimeout } from "../libs/abortSignal";
import { answerCallbackQuery, sendCommandMessage } from "../infra/telegram";
import { combineWithUpdateAbortSignal } from "../infra/updateContext";
import { forumTopicThreadId } from "../libs/forumTopic";
import type { ChatTeardownReason } from "../types/chatTeardown";
import type { WedCandidate, WedChat, WedSession } from "../types/wed";
import { drawWedCandidate } from "./wed/draw";
import { getOrCreateWedChat, teardownWedChat } from "./wed/chats";
import { purgeWedMembers } from "./wed/persistence";
import { confirmWedResult, removeWedResult, replaceWedResult, sendWedResult } from "./wed/messages";

/**
 * 取一份阶段预算，同时服从群 teardown、update 取消与 WED_OPERATION_TIMEOUT_MS。
 *
 * 抽取和投递各取一份：抽取用掉的时间不从投递的预算里扣，口径与 libs/abortSignal.ts
 * 的 signalWithTimeout 一致。单次交互的最坏总时长因此是两份预算，仍然有界；群
 * teardown 与停机取消照旧即时切断两个阶段。
 */
function operationSignal(session: WedSession): AbortSignal {
  return combineWithUpdateAbortSignal(
    signalWithTimeout(session.controller.signal, WED_OPERATION_TIMEOUT_MS)
  )!;
}

/**
 * 出站失败或阶段中止后的群内回执，undefined 表示保持静默。
 *
 * 预算耗尽是普通业务失败，照常回执；群 teardown 与停机取消保持静默——群要没了、
 * 进程要停了，此时再发消息是错的。两者由 libs/abortSignal.ts 的 isTimeoutAbort 区分。
 */
function failureNotice(signal: AbortSignal): string | undefined {
  return signal.aborted && !isTimeoutAbort(signal) ? undefined : WED_TEXTS.failed;
}

/** 抽取落空后的回执：跑完配额确认没有可用头像才是 unavailable，被取消时按取消来源判定。 */
function drawMissNotice(signal: AbortSignal): string | undefined {
  return signal.aborted ? failureNotice(signal) : WED_TEXTS.unavailable;
}

/** 发送阶段回执；文本为 undefined 表示本次保持静默。 */
async function sendWedNotice(
  session: WedSession,
  text: string | undefined,
  replyToMessageId: number | undefined
): Promise<void> {
  if (text === undefined) return;
  await sendCommandMessage({ chatId: session.chatId, text, replyToMessageId });
}

/**
 * 群关闭先同步关闸，再删除状态机拥有的结果；重启不恢复这些会话。
 *
 * 交互缓存与长期成员集合是两份状态，收场也不同：前者按 LRU 淘汰过就可能不在，
 * 后者只要这个群发过言就一直在。因此**成员集合的删除不挂在 `chat !== undefined`
 * 上**——被淘汰过的群同样要把奖池删干净。只有被撤管理员那一路两样都不动：权限
 * 随时可能加回来，那时奖池必须原样还在（见 libs/chatTeardown.ts 的 purgesChatData）。
 */
export async function teardownWedInChat(
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  const chat: WedChat | undefined = wedChats.peek(chatId);
  if (chat !== undefined) {
    wedChats.delete(chatId);
    await teardownWedChat(chat);
  }
  if (purgesChatData(reason)) await purgeWedMembers(chatId);
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
    const drawSignal: AbortSignal = operationSignal(session);
    const candidate: WedCandidate | undefined = await drawWedCandidate(session, chat, drawSignal);
    if (session.controller.signal.aborted) return;
    if (candidate === undefined) {
      await sendWedNotice(session, drawMissNotice(drawSignal), ctx.msgId);
      return;
    }
    // 投递预算必须在删除上一张结果**之前**判定：此刻已被取消就原样留着旧结果。
    const deliverySignal: AbortSignal = operationSignal(session);
    if (deliverySignal.aborted) {
      await sendWedNotice(session, failureNotice(deliverySignal), ctx.msgId);
      return;
    }
    if (previous !== undefined) {
      if (!await removeWedResult(previous)) {
        await sendWedNotice(session, failureNotice(deliverySignal), ctx.msgId);
        return;
      }
      previous.controller.abort();
      replacedPrevious = true;
    }
    if (!await sendWedResult({ session, candidate, replyToMessageId: ctx.msgId, signal: deliverySignal })) {
      await sendWedNotice(session, failureNotice(deliverySignal), ctx.msgId);
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
    // 第一份预算覆盖按钮应答与本动作的第一步：移除、确认或抽取。
    const signal: AbortSignal = operationSignal(session);
    await answerCallbackQuery({ callbackQueryId: query.id,
      text: action === "marry" && session.confirmed ? WED_TEXTS.confirmed : undefined });
    if (signal.aborted) {
      await sendWedNotice(session, failureNotice(signal), session.messageId);
      return true;
    }
    let succeeded: boolean;
    // 更换要先抽取再编辑，编辑另取一份预算；其余动作只有一步，沿用本阶段预算。
    let deliverySignal: AbortSignal = signal;
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
        await sendWedNotice(session, drawMissNotice(signal), session.messageId);
        return true;
      }
      deliverySignal = operationSignal(session);
      succeeded = await replaceWedResult(session, candidate, deliverySignal);
    }
    if (!succeeded) await sendWedNotice(session, failureNotice(deliverySignal), session.messageId);
  } finally {
    session.busy = false;
    if (session.controller.signal.aborted) await removeWedResult(session);
  }
  return true;
}

registerChatTeardown("wed", teardownWedInChat);
