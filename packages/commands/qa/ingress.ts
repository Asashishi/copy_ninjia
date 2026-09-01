/**
 * `/set_qa` 表单的消息收集链路。
 *
 * 用户发出 `/set_qa` -> 本天才回一张写着格式的表单提示 -> 用户按
 * 「问题:」「回答:」的格式**分两条消息**发进本群 -> 本模块认领它们、取出文本、
 * 删掉那两条消息，并把值写回表单会话。
 *
 * **认领判据全部来自 Telegram 给出的事实**：`message.chat.id` 确有未完成表单、
 * 这条消息的**可见身份就是开表单的那个身份**（`sender_chat ?? from`，见
 * users/visibleSender.ts），且正文能解析出本领域的字段标签。三条都对不上的
 * 消息原样放回消息流水线，本模块不碰。
 *
 * 写入资格改为「是不是发起者」而不是再查一次权限，正是频道也能设置问答的原因：
 * 开表单那一步已经按 `isCanControllQaPermission` 把过关（见 commands/qa.ts），
 * 而频道马甲与匿名管理员在命令侧和投递侧看到的是同一个 `sender_chat` id，
 * 两边天然对得上——inline 时代对不上的是「皮套开表单、真人填表单」那两个 id。
 */

import type { Message } from "grammy/types";
import { CHAT_QA_ANSWER_MAX_CHARS, CHAT_QA_QUESTION_MAX_CHARS } from "../../consts/qa";
import { deleteMessageWithOutcome } from "../../infra/telegram";
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
 * @returns 未认领时为 null；认领后消息已删除，调用方只需处理会话状态与回执。
 */
export async function claimQaFieldMessage(
  message: Message
): Promise<QaFormIngressResult | null> {
  // **判据按成本排序，不按重要性**：本函数在每条群消息的主干上被调用，而绝大多数
  // 群任何时刻都没有未完成表单。第一步因此必须是这次以群 id 为键的 Map.get——
  // 数字键、零分配、未命中即返回。commands/qa.ts 的 handleQaMessageIngress 用同一
  // 道判定做同步守卫，因此稳定态根本到不了这里；本函数仍自查一次，好让它作为
  // 独立入口（单测直接调用）保持自洽。`isBotOwnMessage` 在它后面：它同样零分配
  // ——`infra/selfSentTracker.ts` 按 (chatId, messageId) 两级整数键直查，不拼复合串
  // （见 AGENTS.md「高频路径不得创建复合键」）——但一条消息最多要查两对键，
  // 仍比这里一次未命中即返回的 Map.get 贵。这些判据都只是 return null，
  // 先后顺序不影响结论，因此最贵的那道——跨线程 rendezvous——排在全部廉价判据
  // 之后、任何副作用之前。
  const session: QaFormSession | undefined = findQaFormSession(message.chat.id);
  if (session === undefined) return null;
  if (message.message_id === session.formMessageId) return null;
  // 频道里本天才自己发的帖会作为 channel_post 原样推回来（见 selfSentTracker），
  // 而表单提示正文里就写着「问题:」「回答:」两行示例——不挡住的话，那张表单
  // 会拿自己的示例文本把自己填满。上面按 id 的判定只挡得住表单消息本身，
  // 回执与看板同样是本天才发的，仍要这一关。
  if (isBotOwnMessage(message)) return null;
  const actorId: number | undefined = messageActorId(message);
  if (actorId === undefined || actorId !== session.openedById) return null;
  const parsed: QaFieldInput | undefined = parseQaFieldMessage(message);
  if (parsed === undefined) return null;
  // 上面那条同步判定覆盖的是**本次 update 内主线程自己发的**那几条（表单、回执、
  // 看板）：runner 严格串行，它们的 markSelfSent 必然早于回投 update 被取回。
  // Worker 发的消息由代理边界在主线程登记（infra/telegram/workerRequests.ts 的
  // markWorkerSentMessage），但登记时刻是发送响应落地，而回投可能由一次并发的长
  // 轮询先取回，两者没有顺序保证。而频道帖的可见身份就是频道自己，与频道身份开的
  // 表单 `openedById` 恒相等，上面按身份的判据挡不住它，因此这道有界 rendezvous
  // 是「一条以『回答:』开头的 AI 回复被当成投递认领并删掉」的唯一闸门——它成立的
  // 前提正是那次登记必然会到。口径与 auto/message/index.ts、commands/cjkAction.ts
  // 一致：群聊与私聊不会回投，needsBotOwnMessageWait 在那里直接短路，不建 promise
  // 也不建 timer。
  if (needsBotOwnMessageWait(message) && await waitForBotOwnMessage(message)) return null;

  // 认领之后立刻删掉这条投递消息：它只是把文本带进表单的载具，答案还可能是
  // 一整块 JSON，留在群里既没意义又会被后面的流水线当成普通消息。
  await deleteMessageWithOutcome(message.chat.id, message.message_id);

  const questionTooLong: boolean = parsed.q !== undefined &&
    parsed.q.length > CHAT_QA_QUESTION_MAX_CHARS;
  const answerTooLong: boolean = parsed.a !== undefined &&
    parsed.a.length > CHAT_QA_ANSWER_MAX_CHARS;
  // 超长的那一项不写进会话：表单留着，用户重发一条合规的即可覆盖。
  const question: string | undefined = questionTooLong ? undefined : parsed.q;
  const answer: string | undefined = answerTooLong ? undefined : parsed.a;
  if (question !== undefined) session.q = question;
  if (answer !== undefined) session.a = answer;
  return {
    session,
    accepted: { q: question, a: answer },
    questionTooLong,
    answerTooLong,
  };
}
