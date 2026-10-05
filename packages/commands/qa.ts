import { chatQaEntries, qaFormSessions } from "../cache/main/qa";
import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
/**
 * 群问答的三个子命令：`/qa set`、`/qa query`、`/qa remove`。
 *
 * `/qa set` 与 `/qa remove` 需要 `isCanControllQaPermission`（超级管理员恒持有）；
 * `/qa query` 是只读看板，群成员都能用。三条只在已 `/init enable` 的群里可达：
 * 未接管群的命令由 infra/updateGate.ts 的 shouldPassInitGate 挡下。
 *
 * **频道身份可用**：表单靠「问题:」「回答:」两条格式消息收文本，而不是 inline，
 * 因此频道马甲与匿名管理员在命令侧和投递侧是同一个 `sender_chat` id，两边对得上。
 * 写入资格由「是不是开表单的那个身份」判定，权限只在开表单那一步查（见
 * qa/ingress.ts 的文件头注）。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { CHAT_QA_MAX_PER_CHAT, QA_SUBCOMMAND_PATTERN } from "../consts/qa";

import {
  removeAllChatQa,
  removeChatQa,
  setChatQa,
  ChatQaCapacityError,
} from "../infra/qaStore";
import { forumTopicThreadId } from "../libs/forumTopic";
import { settleWithinBudget } from "../libs/inflight";
import { logger } from "../infra/logger";
import { throwIfUpdateAborted } from "../infra/updateContext";
import { sendCommandMessage } from "../infra/telegram";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { purgesChatData } from "../libs/chatTeardown";
import { rejectUnlessPermitted } from "./commandActor";
import type { CachedUser } from "../types/chatState";
import type { ChatTeardownReason } from "../types/chatTeardown";
import type { FlushResult } from "../types/lifecycle";
import type { QaEntry, QaFormIngressResult, QaFormSession } from "../types/qa";
import type { RichTextMessage } from "../types/telegram";
import { buildQaBoardKeyboard, buildQaBoardPages } from "./qa/board";
import { claimQaFieldMessage } from "./qa/ingress";
import { deleteQaForm, editQaForm, sendQaForm } from "./qa/notices";
import { renderQaFormPrompt } from "./qa/rendering";
import {
  closeQaFormSession,
  closeQaFormSessionsInChat,
  openQaFormSession,
} from "./qa/session";

export { handleQaBoardCallback } from "./qa/board";

/** /qa 统一入口；按子命令分派表单、查询或删除。 */
export async function handleQaCommand(ctx: CommandContext<Context>): Promise<void> {
  const match: RegExpExecArray | null = QA_SUBCOMMAND_PATTERN.exec(ctx.match.trim());
  // 子命令词不区分大小写；第二组是用户写的问题文本，保持原样。
  const subcommand: string | undefined = match?.[1]?.toLowerCase();
  const argument: string = match?.[2] ?? "";
  if (subcommand === "set" && argument.length === 0) {
    await setQa(ctx);
  } else if (subcommand === "query") {
    await queryQa(ctx, argument);
  } else if (subcommand === "remove") {
    await removeQa(ctx, argument);
  } else {
    await sendCommandMessage({ chatId: ctx.chat.id, text: chatAtmosphere().QA_USAGE_TEXT, replyToMessageId: ctx.msgId });
  }
}

/** 维护类命令的权限闸；`/qa query` 不走这里。放行时返回发起身份，拒绝时已回执并返回 undefined。 */
function requiresQaPermission(ctx: CommandContext<Context>): Promise<CachedUser | undefined> {
  return rejectUnlessPermitted(
    ctx,
    "isCanControllQaPermission",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.QA_COMMAND_TEXTS.rejected(actorLabel)
  );
}

/** 表单被结算（填齐、到期或 teardown）时统一收走那条提示消息。 */
function discardQaForm(session: QaFormSession): void {
  void deleteQaForm(session).catch((error: unknown): void => {
    logger.error(`Failed to delete the qa form in chat ${session.chatId}:`, error);
  });
}

/** 处理 `/qa set`：开一张表单，等发起者按格式把问题和回答发进来。 */
async function setQa(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await requiresQaPermission(ctx);
  if (actor === undefined) return;
  if ((chatQaEntries.get(chatId)?.size ?? 0) >= CHAT_QA_MAX_PER_CHAT) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().QA_COMMAND_TEXTS.full,
      replyToMessageId: messageId,
    });
    return;
  }
  const openedById: number = actor.id;
  // 同一发起人可重开；其他身份不能替换当前会话。
  const existing: QaFormSession | undefined = qaFormSessions.get(chatId);
  if (existing !== undefined && existing.openedById !== openedById) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().QA_COMMAND_TEXTS.formTaken,
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
      text: chatAtmosphere().QA_COMMAND_TEXTS.formBusy,
      replyToMessageId: messageId,
    });
    return;
  }
  try {
    const formMessageId: number | undefined = await sendQaForm({
      chatId,
      text: renderQaFormPrompt(undefined, undefined, chatAtmosphere()),
      replyToMessageId: messageId,
      messageThreadId: forumTopicThreadId(ctx.msg),
      // 拿到 id 的同步时点就登记：停机 abort 会丢掉返回值，但不能丢掉这条
      // 已发消息的删除责任。
      onSent: (formMessageId: number): void => {
        session.formMessageId = formMessageId;
        if (qaFormSessions.get(chatId) !== session) discardQaForm(session);
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
        text: error instanceof ChatQaCapacityError ? chatAtmosphere().QA_COMMAND_TEXTS.full : chatAtmosphere().QA_COMMAND_TEXTS.persistFailed,
        replyToMessageId: formMessageId,
      });
      return;
    }
    await sendCommandMessage({
      chatId,
      text: outcome === "replaced" ? chatAtmosphere().QA_COMMAND_TEXTS.replaced : chatAtmosphere().QA_COMMAND_TEXTS.created,
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
  if (qaFormSessions.get(message.chat.id) === undefined) return false;
  return claimQaFormDelivery(message);
}

/** 认领判定与回执的异步段；只有本群确实开着一张表单时才走到。 */
async function claimQaFormDelivery(message: Message): Promise<boolean> {
  const claimed: QaFormIngressResult | null = await claimQaFieldMessage(message);
  if (claimed === null) return false;
  const session: QaFormSession = claimed.session;
  const chatId: number = session.chatId;
  throwIfUpdateAborted();
  if (qaFormSessions.get(chatId) !== session) return true;

  // 超长的那一项没写进会话，先把它说清楚；表单留着等一条合规的重发。同一条
  // 消息里另一项合规时它已经进了会话，表单要跟上；两项都被挡下时会话一个字
  // 都没变，就不为一次「内容没有变化」的改写多跑一趟 Telegram。
  if (claimed.questionTooLong || claimed.answerTooLong) {
    if (claimed.accepted.q !== undefined || claimed.accepted.a !== undefined) {
      await editQaForm(session, renderQaFormPrompt(session.q, session.a, chatAtmosphere()));
    }
    if (qaFormSessions.get(chatId) !== session) return true;
    await sendCommandMessage({
      chatId,
      text: claimed.questionTooLong
        ? chatAtmosphere().QA_COMMAND_TEXTS.questionTooLong
        : chatAtmosphere().QA_COMMAND_TEXTS.answerTooLong,
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
    await editQaForm(session, renderQaFormPrompt(q, a, chatAtmosphere()));
    if (qaFormSessions.get(chatId) !== session) return true;
    await sendCommandMessage({
      chatId,
      text: claimed.accepted.q !== undefined
        ? chatAtmosphere().QA_COMMAND_TEXTS.questionSaved
        : chatAtmosphere().QA_COMMAND_TEXTS.answerSaved,
      replyToMessageId: session.formMessageId,
    });
    return true;
  }
  await settleQaForm(session, q, a);
  return true;
}

/** 处理 `/qa query`：不带参数列全部，带参数查一条；两者都长期保留。 */
async function queryQa(ctx: CommandContext<Context>, wanted: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const entries: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  if (entries === undefined || entries.size === 0) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().QA_COMMAND_TEXTS.queryEmpty,
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
        text: chatAtmosphere().QA_COMMAND_TEXTS.queryMissing(wanted),
        replyToMessageId: messageId,
      });
      return;
    }
    selected.push({ q: wanted, a: answer });
  } else {
    for (const [q, a] of entries) selected.push({ q, a });
  }
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const pages: readonly RichTextMessage[] = buildQaBoardPages(selected, atmosphere);
  const first: RichTextMessage | undefined = pages[0];
  if (first === undefined) return;
  await sendCommandMessage({
    chatId,
    text: first.text,
    entities: first.entities,
    keyboard: buildQaBoardKeyboard(0, pages.length, atmosphere),
    replyToMessageId: messageId,
    // 与 /permission query 同一口径的长期保留例外：这是一张要照着逐条核对的
    // 看板，30 秒清理会在读完之前收走它。查不到那条的提示仍走默认清理。
    preserveInGroup: true,
    // 长期保留 ⇒ 自己带话题，见 SendMessageParams.messageThreadId。
    messageThreadId: forumTopicThreadId(ctx.msg),
  });
}

/** 处理 `/qa remove <问题文本>`：删掉本群指定问答。 */
async function removeQa(ctx: CommandContext<Context>, wanted: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (await requiresQaPermission(ctx) === undefined) return;
  if (wanted.length === 0) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().QA_COMMAND_TEXTS.removeUsage,
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
      text: chatAtmosphere().QA_COMMAND_TEXTS.persistFailed,
      replyToMessageId: messageId,
    });
    return;
  }
  await sendCommandMessage({
    chatId,
    // 回执必须如实：没删到就说没这条，不能一律回「删好了」让人以为生效了。
    text: removed
      ? chatAtmosphere().QA_COMMAND_TEXTS.removed(wanted)
      : chatAtmosphere().QA_COMMAND_TEXTS.removeMissing(wanted),
    replyToMessageId: messageId,
  });
}

/** 机器人已离群：表单消息删不掉，关闭会话后直接作废消息 id，不发删除请求。 */
function abandonQaForm(session: QaFormSession): void {
  session.formMessageId = undefined;
}

/**
 * 群 teardown / `/init disable`：收走该群全部未完成表单，并在要删数据时删掉已登记的问答。
 *
 * 表单一律收走，表单消息只在机器人仍在群里时删除；问答只在本次 teardown 要删数据时删
 * （见 libs/chatTeardown.ts 的 purgesChatData）。被撤管理员那一路只是暂时干不了活，问答
 * 必须原样留着——权限加回来之后直答要照旧生效；而 `/init disable` 与离群的语义是「本天才
 * 不再管这个群」，本群的数据一样不留。
 */
export function teardownQaInChat(chatId: number, reason: ChatTeardownReason): void {
  closeQaFormSessionsInChat(chatId, reason === "departed" ? abandonQaForm : discardQaForm);
  if (purgesChatData(reason)) removeAllChatQa(chatId);
}

/**
 * 停机在 Telegram 总闸关闭前收走全部未完成表单，并在预算内等删除请求结算。
 *
 * 表单不挂固定延迟删除、TTL timer 不扣住进程退出，不在这里收走的话重启后就无人删除。
 * 零预算不发起新请求；发送仍在途的表单由迟到的 onSent 回调接手删除。
 */
export async function drainQaForms(timeoutMs: number): Promise<FlushResult> {
  if (qaFormSessions.size === 0) return "flushed";
  if (timeoutMs <= 0) return "timedOut";
  const deletions: Promise<void>[] = [];
  for (const session of [...qaFormSessions.values()]) {
    closeQaFormSession(session);
    deletions.push(deleteQaForm(session));
  }
  return await settleWithinBudget(deletions, timeoutMs) ? "flushed" : "timedOut";
}

registerChatTeardown("qa", teardownQaInChat);
