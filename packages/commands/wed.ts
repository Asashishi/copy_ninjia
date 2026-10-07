import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CallbackQuery, User } from "grammy/types";
import { wedChats } from "../cache/main/wed";
import { WED_CALLBACK_PREFIX, WED_OPERATION_TIMEOUT_MS, WED_SESSION_LIMIT } from "../consts/wed";

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
import { parseUserIdArgument } from "../libs/telegramId";
import { purgeWedMembers } from "./wed/persistence";
import { confirmWedResult, removeWedResult, replaceWedResult, sendWedResult } from "./wed/messages";

/**
 * 取一份阶段预算，同时服从群 teardown、update 取消与 WED_OPERATION_TIMEOUT_MS。
 *
 * 抽取和投递各取一份，互不扣减（口径与 libs/abortSignal.ts 的 signalWithTimeout 一致）；
 * 群 teardown 与停机取消即时切断两个阶段。
 */
function operationSignal(session: WedSession): AbortSignal {
  return combineWithUpdateAbortSignal(
    signalWithTimeout(session.controller.signal, WED_OPERATION_TIMEOUT_MS)
  )!;
}

/**
 * 出站失败或阶段中止后的群内回执，undefined 表示保持静默。
 *
 * 预算耗尽照常回执；群 teardown 与停机取消保持静默。两者由 libs/abortSignal.ts 的
 * isTimeoutAbort 区分。
 */
function failureNotice(signal: AbortSignal): string | undefined {
  return signal.aborted && !isTimeoutAbort(signal) ? undefined : chatAtmosphere().WED_TEXTS.failed;
}

/** 抽取落空后的回执：跑完配额确认没有可用头像才是 unavailable，被取消时按取消来源判定。 */
function drawMissNotice(signal: AbortSignal): string | undefined {
  return signal.aborted ? failureNotice(signal) : chatAtmosphere().WED_TEXTS.unavailable;
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
 * 群关闭先同步关闸，再删除状态机拥有的结果（机器人已离群时不删，见 teardownWedChat）；
 * 重启不恢复这些会话。
 *
 * 交互缓存（wedChats）与长期成员集合是两份状态：成员集合的删除不依赖 wedChats 里有
 * 该群条目。只有 purgesChatData(reason) 为真时才删成员集合（见 libs/chatTeardown.ts），
 * `lostAuthority` 只收交互、保留成员集合。
 */
export async function teardownWedInChat(
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  const chat: WedChat | undefined = wedChats.get(chatId);
  if (chat !== undefined) {
    wedChats.delete(chatId);
    await teardownWedChat(chatId, chat, reason);
  }
  if (purgesChatData(reason)) await purgeWedMembers(chatId);
}

/**
 * 每位用户在群里保留一张可操作的结果；重复命令重新抽取并回复新命令。
 * 新结果送达后才放弃并删除旧结果；送达失败时旧结果与原会话原样保留。旧结果删除失败
 * （已按统一 Telegram 错误日志记录）时那张图留在群里，按钮因会话已换成新结果而只回执过期。
 */
export async function handleWedCommand(ctx: CommandContext<Context>): Promise<void> {
  const actor: User | undefined = ctx.from;
  if ((ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") ||
    ctx.msg.sender_chat !== undefined || actor === undefined || actor.is_bot) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: chatAtmosphere().WED_TEXTS.groupOnly, replyToMessageId: ctx.msgId });
    return;
  }
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: chatAtmosphere().WED_TEXTS.usage, replyToMessageId: ctx.msgId });
    return;
  }
  const chat: WedChat | undefined = getOrCreateWedChat(ctx.chat.id);
  const previous: WedSession | undefined = chat?.sessions.get(actor.id);
  const rejected: string | undefined = previous?.busy ? chatAtmosphere().WED_TEXTS.busy
    : chat === undefined || (previous === undefined && chat.sessions.size >= WED_SESSION_LIMIT) ? chatAtmosphere().WED_TEXTS.full
    : chat.members.size === 0 || (chat.members.size === 1 && chat.members.has(actor.id)) ? chatAtmosphere().WED_TEXTS.empty
    : undefined;
  if (rejected !== undefined || chat === undefined) {
    await sendCommandMessage({ chatId: ctx.chat.id, text: rejected ?? chatAtmosphere().WED_TEXTS.full, replyToMessageId: ctx.msgId });
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
  try {
    const drawSignal: AbortSignal = operationSignal(session);
    const candidate: WedCandidate | undefined = await drawWedCandidate(session, chat, drawSignal);
    if (session.controller.signal.aborted) return;
    if (candidate === undefined) {
      await sendWedNotice(session, drawMissNotice(drawSignal), ctx.msgId);
      return;
    }
    const deliverySignal: AbortSignal = operationSignal(session);
    if (deliverySignal.aborted) {
      await sendWedNotice(session, failureNotice(deliverySignal), ctx.msgId);
      return;
    }
    if (!await sendWedResult({ session, candidate, replyToMessageId: ctx.msgId, signal: deliverySignal })) {
      await sendWedNotice(session, failureNotice(deliverySignal), ctx.msgId);
      return;
    }
    // 群 teardown 先于迟到的送达时，新旧结果都交给 finally 按是否离群清理。
    if (previous !== undefined && !session.controller.signal.aborted) {
      previous.controller.abort();
      await removeWedResult(previous);
    }
  } finally {
    session.busy = false;
    if (session.controller.signal.aborted) {
      // 机器人已离群时新旧结果都删不掉，不发删除请求。
      if (!chat.departed) {
        await removeWedResult(session);
        if (previous !== undefined) await removeWedResult(previous);
      }
    } else if (session.messageId === undefined) {
      // 新结果没送达：旧结果还没被放弃，换回原会话。
      if (previous !== undefined) chat.sessions.set(session.actor.id, previous);
      else chat.sessions.delete(session.actor.id);
    }
  }
}

/** 按钮动作名；回调数据里的其它取值一律按过期处理。 */
type WedButtonAction = "remove" | "marry" | "change";

function parseWedButtonAction(value: string | undefined): WedButtonAction | undefined {
  return value === "remove" || value === "marry" || value === "change" ? value : undefined;
}

/** 按钮动作所需的群、会话与已校验的动作名。 */
interface WedCallbackAction {
  readonly chat: WedChat;
  readonly session: WedSession;
  readonly action: WedButtonAction;
}

/** 执行一次按钮动作；会话已置忙，结束时释放，期间被取消则删除结果。 */
async function runWedCallbackAction({ chat, session, action }: WedCallbackAction): Promise<void> {
  try {
    // 第一份预算覆盖本动作的第一步：移除、确认或抽取。
    const signal: AbortSignal = operationSignal(session);
    if (signal.aborted) {
      await sendWedNotice(session, failureNotice(signal), session.messageId);
      return;
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
      if (session.confirmed) return;
      succeeded = await confirmWedResult(session, signal);
    } else {
      const candidate: WedCandidate | undefined = await drawWedCandidate(session, chat, signal);
      if (session.controller.signal.aborted) return;
      if (candidate === undefined) {
        await sendWedNotice(session, drawMissNotice(signal), session.messageId);
        return;
      }
      deliverySignal = operationSignal(session);
      succeeded = await replaceWedResult(session, candidate, deliverySignal);
    }
    if (!succeeded) await sendWedNotice(session, failureNotice(deliverySignal), session.messageId);
  } finally {
    session.busy = false;
    if (session.controller.signal.aborted) await removeWedResult(session);
  }
}

/**
 * 认领 /wed 回调，校验群、消息、发起人和当前目标。按钮应答先于动作发出、与动作同时进行，
 * 两者都结算后才结束本次交互；任一方抛出（update 取消）时原样上抛。
 */
export async function handleWedCallback(ctx: Context): Promise<boolean> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  if (!query?.data?.startsWith(WED_CALLBACK_PREFIX)) return false;
  const parts: string[] = query.data.slice(WED_CALLBACK_PREFIX.length).split(":");
  // 与命令参数共用同一道严格十进制判定（见 libs/telegramId.ts 的 parseUserIdArgument）。
  const actorId: number | undefined = parseUserIdArgument(parts[0] ?? "");
  const targetId: number | undefined = parseUserIdArgument(parts[1] ?? "");
  const action: WedButtonAction | undefined = parseWedButtonAction(parts[2]);
  const message: CallbackQuery["message"] = query.message;
  const chat: WedChat | undefined = message === undefined ? undefined : wedChats.get(message.chat.id);
  const session: WedSession | undefined = actorId === undefined ? undefined : chat?.sessions.get(actorId);
  const rejected: string | undefined = parts.length !== 3 || actorId === undefined || targetId === undefined ||
    action === undefined ||
    message === undefined || message.date === 0 || session?.messageId !== message.message_id
    ? chatAtmosphere().WED_TEXTS.expired : query.from.id !== session.actor.id ? chatAtmosphere().WED_TEXTS.ownerOnly
    : session.targetId !== targetId ? chatAtmosphere().WED_TEXTS.updated
    : session.busy ? chatAtmosphere().WED_TEXTS.busy : undefined;
  if (rejected !== undefined || session === undefined || chat === undefined || action === undefined) {
    await answerCallbackQuery({ callbackQueryId: query.id, text: rejected ?? chatAtmosphere().WED_TEXTS.expired });
    return true;
  }
  session.busy = true;
  const settlements: PromiseSettledResult<void>[] = await Promise.allSettled([
    answerCallbackQuery({ callbackQueryId: query.id,
      text: action === "marry" && session.confirmed ? chatAtmosphere().WED_TEXTS.confirmed : undefined }),
    runWedCallbackAction({ chat, session, action }),
  ]);
  for (const settlement of settlements) {
    if (settlement.status === "rejected") throw settlement.reason;
  }
  return true;
}

registerChatTeardown("wed", teardownWedInChat);
