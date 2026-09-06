/**
 * 收集当前表单发起者投递的问题与回答；字段消息进入删除流程后由本领域认领。
 * 异步等待后复核会话身份，关闭的会话不再接收字段；跨模块约束见 docs/cn/04-invariants.md。
 */

import type { Message } from "grammy/types";
import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { deleteMessageWithOutcome } from "../../infra/telegram";
import { throwIfUpdateAborted } from "../../infra/updateContext";
import {
  isBotOwnMessage,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../infra/selfSentTracker";
import { visibleSenderChat } from "../../users/visibleSender";
import type { QaFieldInput, QaFormIngressResult, QaFormSession } from "../../types/qa";
import { findQaFormSession } from "./session";
import { parseQaFieldMessage } from "./rendering";

/** 这条消息对外可见的发起身份 id；拿不到时 undefined。 */
function messageActorId(message: Message): number | undefined {
  return visibleSenderChat(message)?.id ?? message.from?.id;
}

/**
 * 认领一条表单投递消息并写回会话。
 *
 * @returns 未认领时为 null；进入删除流程后始终返回认领结果，调用方复核会话后处理回执。
 */
export async function claimQaFieldMessage(
  message: Message
): Promise<QaFormIngressResult | null> {
  // 无表单时只查一次 Map；频道自发标记等待排在身份与格式检查之后。
  const session: QaFormSession | undefined = findQaFormSession(message.chat.id);
  if (session === undefined) return null;
  if (message.message_id === session.formMessageId) return null;
  // 频道回投包含表单示例、回执及 Worker 回复；自发消息不参与字段收集。
  if (isBotOwnMessage(message)) return null;
  const actorId: number | undefined = messageActorId(message);
  if (actorId === undefined || actorId !== session.openedById) return null;
  const parsed: QaFieldInput | undefined = parseQaFieldMessage(message);
  if (parsed === undefined) return null;
  // Worker 发送登记与频道回投没有顺序保证，频道帖先等待有界自发标记。
  if (needsBotOwnMessageWait(message) && await waitForBotOwnMessage(message)) return null;
  throwIfUpdateAborted();
  if (findQaFormSession(message.chat.id) !== session) return null;

  // 认领之后立刻删掉这条投递消息：它只是把文本带进表单的载具，答案还可能是
  // 一整块 JSON，留在群里既没意义又会被后面的流水线当成普通消息。
  await deleteMessageWithOutcome(message.chat.id, message.message_id);
  throwIfUpdateAborted();

  const active: boolean = findQaFormSession(message.chat.id) === session;
  const questionTooLong: boolean = parsed.q !== undefined &&
    parsed.q.length > CHAT_QA_QUESTION_MAX_CHARS;
  const answerTooLong: boolean = parsed.a !== undefined &&
    parsed.a.length > CHAT_QA_ANSWER_MAX_CHARS;
  // 超长的那一项不写进会话：表单留着，用户重发一条合规的即可覆盖。
  const question: string | undefined = active && !questionTooLong ? parsed.q : undefined;
  const answer: string | undefined = active && !answerTooLong ? parsed.a : undefined;
  if (question !== undefined) session.q = question;
  if (answer !== undefined) session.a = answer;
  return {
    session,
    accepted: { q: question, a: answer },
    questionTooLong,
    answerTooLong,
  };
}
