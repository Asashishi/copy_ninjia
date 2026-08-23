/**
 * 群问答的三条命令：`/set_qa`、`/query_qa`、`/remove_qa`。
 *
 * `/set_qa` 与 `/remove_qa` 需要 `isCanControllQaPermission`（超级管理员恒持有）；
 * `/query_qa` 是只读看板，群成员都能用。三条都要求本群已 `/init enable`——问答
 * 直答挂在消息主干上，没接管的群本来就不该有本天才的动静。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "@grammyjs/types";
import { CHAT_QA_MAX_PER_CHAT, QA_COMMAND_TEXTS } from "../consts/qa";
import { chatQaCount, getChatQa, removeChatQa, setChatQa } from "../infra/qaStore";
import { forumTopicThreadId } from "../libs/forumTopic";
import { getChatState } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { registerChatTeardown } from "../infra/chatTeardown";
import { hasCommandPermission, resolveCommandActor } from "./commandActor";
import type { CachedUser } from "../types/chatState";
import type { QaEntry, QaFormSession } from "../types/qa";
import { claimQaFormMessage } from "./qa/inline";
import type { QaFormIngressResult } from "./qa/inline";
import { deleteQaForm, sendQaForm } from "./qa/notices";
import { formatQaJsonMessage, renderQaFormPrompt } from "./qa/rendering";
import type { QaJsonMessage } from "./qa/rendering";
import {
  closeQaFormSession,
  closeQaFormSessionsInChat,
  openQaFormSession,
} from "./qa/session";

export { handleQaInlineQuery } from "./qa/inline";

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

/**
 * 维护类命令的统一闸：先挡频道马甲，再看权限。`/query_qa` 不走这里。
 *
 * **频道身份一律拒绝**，与 `/permission`、`/white` 拒绝把当前群自己的 identity
 * 当目标同一道理：Telegram 从不告诉本进程皮套底下是谁，给它维护权就等于把本群
 * 问答交给任意一个能用这层皮的人。这里还多一条现实理由——表单靠 inline 回填，
 * 而频道马甲身份根本用不了 inline，放它进来也只会卡在一张永远填不完的表单上。
 */
async function requiresQaPermission(ctx: CommandContext<Context>): Promise<boolean> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (actor?.isChannel === true) {
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: QA_COMMAND_TEXTS.channelActor,
      replyToMessageId: ctx.msgId,
    });
    return false;
  }
  if (hasCommandPermission(ctx, "isCanControllQaPermission")) return true;
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: QA_COMMAND_TEXTS.rejected(actor ? formatUserLabel(actor) : "哪个杂鱼"),
    replyToMessageId: ctx.msgId,
  });
  return false;
}

/** 表单被结算（填齐、到期或 teardown）时统一收走那条按钮消息。 */
function discardQaForm(session: QaFormSession): void {
  void deleteQaForm(session).catch((error: unknown): void => {
    logger.error(`Failed to delete the qa form in chat ${session.chatId}:`, error);
  });
}

/** 处理 `/set_qa`：开一张两按钮表单，两项填齐后由 ingress 结算。 */
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

  const session: QaFormSession | null = openQaFormSession({
    chatId,
    openedById,
    onExpire: discardQaForm,
  });
  if (session === null) {
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.formBusy,
      replyToMessageId: messageId,
    });
    return;
  }
  await sendQaForm({
    chatId,
    text: renderQaFormPrompt(undefined, undefined),
    replyToMessageId: messageId,
    messageThreadId: forumTopicThreadId(ctx.msg),
    // 拿到 id 的同步时点就登记：停机 abort 会丢掉返回值，但不能丢掉这条
    // 已发消息的删除责任。
    onSent: (formMessageId: number): void => {
      session.formMessageId = formMessageId;
    },
  });
}

/**
 * 表单结果落群时的入口；必须排在命令与消息流水线之前。
 *
 * @returns 是否已认领这条消息。认领后调用方必须终止本条 update 的后续处理——
 *   那条中转消息已经被删掉，再喂给 AI 或复读链路只会处理一个不存在的东西。
 */
export async function handleQaMessageIngress(
  message: Message,
  botUserId: number
): Promise<boolean> {
  const claimed: QaFormIngressResult | null = await claimQaFormMessage(message, botUserId);
  if (claimed === null) return false;
  const session: QaFormSession = claimed.session;
  const chatId: number = session.chatId;

  if (!claimed.permitted) {
    // 表单按群索引，因此任何人都能把内容投进来；真正的写入资格在这里判。
    // 表单本身留着，等有资格的人来填。
    await sendCommandMessage({
      chatId,
      text: QA_COMMAND_TEXTS.rejected(
        message.sender_chat?.title ?? message.from?.first_name ?? "哪个杂鱼"
      ),
      // 回复到表单上：话题群里 bot 主动发的消息没有 message_thread_id 就会落进
      // General，而表单在话题里——回执必须跟表单待在同一个话题。
      replyToMessageId: session.formMessageId,
    });
    return true;
  }

  if (session.q === undefined || session.a === undefined) {
    // 还差一项：告诉用户已经收下哪一样，表单留着等另一样。
    await sendCommandMessage({
      chatId,
      text: claimed.field === "q"
        ? QA_COMMAND_TEXTS.questionSaved
        : QA_COMMAND_TEXTS.answerSaved,
      replyToMessageId: session.formMessageId,
    });
    return true;
  }

  const q: string = session.q;
  const a: string = session.a;
  const formMessageId: number | undefined = session.formMessageId;
  // 两项齐了。先结算会话——按钮随即失效，落库期间没人能再往这张表单里投东西。
  // 但**先别删表单消息**：回执要回复到它身上才能留在同一个话题里，而回复一条
  // 已删除的消息会被 Telegram 降级成普通发送，于是又落回 General。删除排在
  // 回执之后，两条成功/失败路径各自负责删。
  closeQaFormSession(session);
  let outcome: "created" | "replaced";
  try {
    outcome = setChatQa(chatId, q, a);
  } catch (error: unknown) {
    logger.error(`Failed to record the qa entry for chat ${chatId}:`, error);
    // 容量拒绝时那条根本没进热表，落盘失败时已经进了——回执必须按这个分，
    // 把「盘写不进去」说成「满了」会让人去删别的问答，白删还是写不进。
    const landed: boolean = getChatQa(chatId)?.get(q) === a;
    await sendCommandMessage({
      chatId,
      text: landed ? QA_COMMAND_TEXTS.persistFailed : QA_COMMAND_TEXTS.full,
      replyToMessageId: formMessageId,
    });
    discardQaForm(session);
    return true;
  }
  await sendCommandMessage({
    chatId,
    text: outcome === "replaced" ? QA_COMMAND_TEXTS.replaced : QA_COMMAND_TEXTS.created,
    replyToMessageId: formMessageId,
  });
  discardQaForm(session);
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
  const rendered: QaJsonMessage = formatQaJsonMessage(selected);
  await sendCommandMessage({
    chatId,
    text: rendered.text,
    entities: rendered.entities,
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
