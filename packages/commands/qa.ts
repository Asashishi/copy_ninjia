/**
 * 群问答的三条命令：`/set_qa`、`/query_qa`、`/remove_qa`。
 *
 * `/set_qa` 与 `/remove_qa` 需要 `isCanControllQaPermission`（超级管理员恒持有）；
 * `/query_qa` 是只读看板，群成员都能用。三条都要求本群已 `/init enable`——问答
 * 直答挂在消息主干上，没接管的群本来就不该有本天才的动静。
 *
 * **频道身份可用**：表单靠「问题:」「回答:」两条格式消息收文本，而不是 inline，
 * 因此频道马甲与匿名管理员在命令侧和投递侧是同一个 `sender_chat` id，两边对得上。
 * 写入资格由「是不是开表单的那个身份」判定，权限只在开表单那一步查（见
 * qa/ingress.ts 的文件头注）。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { CHAT_QA_MAX_PER_CHAT, QA_COMMAND_TEXTS } from "../consts/qa";
import { chatQaCount, getChatQa, removeChatQa, setChatQa } from "../infra/qaStore";
import { forumTopicThreadId } from "../libs/forumTopic";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { throwIfUpdateAborted } from "../infra/updateContext";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import type { CachedUser } from "../types/chatState";
import type { QaEntry, QaFormIngressResult, QaFormSession } from "../types/qa";
import type { RichTextMessage } from "../types/telegram";
import { buildQaBoardKeyboard, buildQaBoardPages } from "./qa/board";
import { claimQaFieldMessage } from "./qa/ingress";
import { deleteQaForm, editQaForm, sendQaForm } from "./qa/notices";
import { renderQaFormPrompt } from "./qa/rendering";
import {
  closeQaFormSession,
  closeQaFormSessionsInChat,
  findQaFormSession,
  openQaFormSession,
} from "./qa/session";

export { handleQaBoardCallback } from "./qa/board";

/** 本群是否已接管；未接管时统一回同一句，不区分命令。 */
async function requiresInitialized(
  chatId: number,
  messageId: number | undefined
): Promise<boolean> {
  if (getChatState(chatId).isInitEnabled === true) return true;
  await sendCommandMessage({
    chatId,
    text: QA_COMMAND_TEXTS.notInitialized,
    replyToMessageId: messageId,
  });
  return false;
}

/** 维护类命令的权限闸；`/query_qa` 不走这里。 */
async function requiresQaPermission(ctx: CommandContext<Context>): Promise<boolean> {
  if (hasCommandPermission(ctx, "isCanControllQaPermission")) return true;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: QA_COMMAND_TEXTS.rejected(actor ? formatUserLabel(actor) : "哪个杂鱼"),
    replyToMessageId: ctx.msgId,
  });
  return false;
}

/** 表单被结算（填齐、到期或 teardown）时统一收走那条提示消息。 */
function discardQaForm(session: QaFormSession): void {
  void deleteQaForm(session).catch((error: unknown): void => {
    logger.error(`Failed to delete the qa form in chat ${session.chatId}:`, error);
  });
}

/** 处理 `/set_qa`：开一张表单，等发起者按格式把问题和回答发进来。 */
export async function handleSetQaCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!await requiresInitialized(chatId, messageId)) return;
  if (!await requiresQaPermission(ctx)) return;
  if (chatQaCount(chatId) >= CHAT_QA_MAX_PER_CHAT) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.full,
      replyToMessageId: messageId,
    });
    return;
  }
  const openedById: number | undefined = resolveCommandActor(ctx)?.id;
  if (openedById === undefined) return;
  // 同一发起人可重开；其他身份不能替换当前会话。
  const existing: QaFormSession | undefined = findQaFormSession(chatId);
  if (existing !== undefined && existing.openedById !== openedById) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.formTaken,
      replyToMessageId: messageId,
    });
    return;
  }

  const session: QaFormSession | null = openQaFormSession({
    chatId,
    openedById,
    onDiscard: discardQaForm,
  });
  if (session === null) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.formBusy,
      replyToMessageId: messageId,
    });
    return;
  }
  try {
    const formMessageId: number | undefined = await sendQaForm({
      chatId,
      text: renderQaFormPrompt(undefined, undefined),
      replyToMessageId: messageId,
      messageThreadId: forumTopicThreadId(ctx.msg),
      // 拿到 id 的同步时点就登记：停机 abort 会丢掉返回值，但不能丢掉这条
      // 已发消息的删除责任。
      onSent: (formMessageId: number): void => {
        session.formMessageId = formMessageId;
        if (findQaFormSession(chatId) !== session) discardQaForm(session);
      },
    });
    if (formMessageId === undefined) {
      closeQaFormSession(session);
      discardQaForm(session);
    }
  } catch (error: unknown) {
    closeQaFormSession(session);
    discardQaForm(session);
    throw error;
  }
}

/** 两项填齐后落库并回执；表单在回执之后才删。 */
async function settleQaForm(session: QaFormSession, q: string, a: string): Promise<void> {
  const chatId: number = session.chatId;
  const formMessageId: number | undefined = session.formMessageId;
  // 同步取得结算资格后写入；表单保留到回执完成，以维持话题内的回复关系。
  throwIfUpdateAborted();
  if (!closeQaFormSession(session)) return;
  try {
    let outcome: "created" | "replaced";
    try {
      outcome = setChatQa(chatId, q, a);
    } catch (error: unknown) {
      logger.error(`Failed to record the qa entry for chat ${chatId}:`, error);
      await sendCommandMessage({
        chatId,
        text: error instanceof ChatQaCapacityError ? QA_COMMAND_TEXTS.full : QA_COMMAND_TEXTS.persistFailed,
        replyToMessageId: formMessageId,
      });
      return;
    }
    await sendCommandMessage({
      chatId,
      text: outcome === "replaced" ? QA_COMMAND_TEXTS.replaced : QA_COMMAND_TEXTS.created,
      replyToMessageId: formMessageId,
    });
  } finally {
    discardQaForm(session);
  }
}

/**
 * 消息流水线前置认领入口，无会话时同步返回 false，不分配 Promise。
 * 进入删除流程后返回 true，禁止下游再次处理该消息；见 docs/cn/04-invariants.md。
 */
export function handleQaMessageIngress(message: Message): boolean | Promise<boolean> {
  if (findQaFormSession(message.chat.id) === undefined) return false;
  return claimQaFormDelivery(message);
}

/** 认领判定与回执的异步段；只有本群确实开着一张表单时才走到。 */
async function claimQaFormDelivery(message: Message): Promise<boolean> {
  const claimed: QaFormIngressResult | null = await claimQaFieldMessage(message);
  if (claimed === null) return false;
  const session: QaFormSession = claimed.session;
  const chatId: number = session.chatId;
  throwIfUpdateAborted();
  if (findQaFormSession(chatId) !== session) return true;

  // 超长的那一项没写进会话，先把它说清楚；表单留着等一条合规的重发。同一条
  // 消息里另一项合规时它已经进了会话，表单要跟上；两项都被挡下时会话一个字
  // 都没变，就不为一次「内容没有变化」的改写多跑一趟 Telegram。
  if (claimed.questionTooLong || claimed.answerTooLong) {
    if (claimed.accepted.q !== undefined || claimed.accepted.a !== undefined) {
      await editQaForm(session, renderQaFormPrompt(session.q, session.a));
    }
    if (findQaFormSession(chatId) !== session) return true;
    await sendCommandMessage({
      chatId,
      text: claimed.questionTooLong
        ? QA_COMMAND_TEXTS.questionTooLong
        : QA_COMMAND_TEXTS.answerTooLong,
      // 回复到表单上：话题群里 bot 主动发的消息没有 message_thread_id 就会落进
      // General，而表单在话题里——回执必须跟表单待在同一个话题。
      replyToMessageId: session.formMessageId,
    });
    return true;
  }

  const q: string | undefined = session.q;
  const a: string | undefined = session.a;
  if (q === undefined || a === undefined) {
    // 还差一项：表单先跟上，再告诉用户已经收下哪一样。回执 30 秒后就自删，
    // 之后只有表单还说得出这张单子填到了哪（见 qa/notices.ts 的 editQaForm）。
    await editQaForm(session, renderQaFormPrompt(q, a));
    if (findQaFormSession(chatId) !== session) return true;
    await sendCommandMessage({
      chatId,
      text: claimed.accepted.q !== undefined
        ? QA_COMMAND_TEXTS.questionSaved
        : QA_COMMAND_TEXTS.answerSaved,
      replyToMessageId: session.formMessageId,
    });
    return true;
  }
  await settleQaForm(session, q, a);
  return true;
}

/** 处理 `/query_qa`：不带参数列全部，带参数查一条；两者都长期保留。 */
export async function handleQueryQaCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!await requiresInitialized(chatId, messageId)) return;
  const wanted: string = ctx.match.trim();
  const entries: ReadonlyMap<string, string> | undefined = getChatQa(chatId);
  if (entries === undefined || entries.size === 0) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.queryEmpty,
      replyToMessageId: messageId,
    });
    return;
  }
  const selected: QaEntry[] = [];
  if (wanted.length > 0) {
    const answer: string | undefined = entries.get(wanted);
    if (answer === undefined) {
      await sendCommandMessage({
        chatId,
        text: QA_COMMAND_TEXTS.queryMissing(wanted),
        replyToMessageId: messageId,
      });
      return;
    }
    selected.push({ q: wanted, a: answer });
  } else {
    for (const [q, a] of entries) selected.push({ q, a });
  }
  const pages: readonly RichTextMessage[] = buildQaBoardPages(selected);
  const first: RichTextMessage | undefined = pages[0];
  if (first === undefined) return;
  await sendCommandMessage({
    chatId,
    text: first.text,
    entities: first.entities,
    keyboard: buildQaBoardKeyboard(0, pages.length),
    replyToMessageId: messageId,
    // 与 /permission query 同一口径的长期保留例外：这是一张要照着逐条核对的
    // 看板，30 秒清理会在读完之前收走它。查不到那条的提示仍走默认清理。
    preserveInGroup: true,
    // 长期保留 ⇒ 自己带话题，理由见 SendMessageParams.messageThreadId。
    messageThreadId: forumTopicThreadId(ctx.msg),
  });
}

/** 处理 `/remove_qa <问题文本>`：删掉本群指定问答。 */
export async function handleRemoveQaCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!await requiresInitialized(chatId, messageId)) return;
  if (!await requiresQaPermission(ctx)) return;
  const wanted: string = ctx.match.trim();
  if (wanted.length === 0) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.removeUsage,
      replyToMessageId: messageId,
    });
    return;
  }
  let removed: boolean;
  try {
    removed = removeChatQa(chatId, wanted);
  } catch (error: unknown) {
    logger.error(`Failed to remove the qa entry for chat ${chatId}:`, error);
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.persistFailed,
      replyToMessageId: messageId,
    });
    return;
  }
  await sendCommandMessage({
    chatId,
    // 回执必须如实：没删到就说没这条，不能一律回「删好了」让人以为生效了。
    text: removed
      ? QA_COMMAND_TEXTS.removed(wanted)
      : QA_COMMAND_TEXTS.removeMissing(wanted),
    replyToMessageId: messageId,
  });
}

/**
 * 群 teardown / `/init disable`：收走该群全部未完成表单。
 *
 * 只清表单，**不删已登记的问答**：teardown 的语义是「本天才不再管这个群」，
 * 而问答是部署方登记的配置，重新 /init enable 之后应当照旧生效。真要删得走
 * /remove_qa。
 */
export function teardownQaInChat(chatId: number): void {
  closeQaFormSessionsInChat(chatId, discardQaForm);
}

registerChatTeardown("qa", teardownQaInChat);
import { ChatQaCapacityError } from "../infra/qaStore";
