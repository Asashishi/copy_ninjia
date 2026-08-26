/**
 * `/set_qa` 表单提示的 Telegram 动作边界。
 *
 * 表单是**状态机拥有的消息**，与入群验证按钮同类：它只能由「两项填齐」、
 * TTL 到期或群 teardown 这三条状态机路径删除，不能挂命令文本那条固定 30 秒
 * 清理——用户正照着它写问题和回答，消息却在 30 秒后自己消失。因此这里直接用
 * sendMessage，并在 scripts/checkProjectConventions.ts 里登记了对应豁免。
 */

import {
  deleteMessageWithOutcome,
  editMessageText,
  sendMessage,
} from "../../infra/telegram";
import type { QaFormSession } from "../../types/qa";

export interface SendQaFormParams {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  /**
   * `/set_qa` 所在的论坛话题。
   *
   * 表单不挂固定延迟清理（见文件头注），会一直留到填齐、TTL 到期或群 teardown，
   * 因此必须自己带话题：只靠 reply_parameters 的话，命令消息被删掉时这张正在
   * 填的表单会落进 General（见 SendMessageParams.messageThreadId）。
   */
  readonly messageThreadId: number | undefined;
  /** 远端返回 id 后同步登记，关闭停机 abort 丢失表单身份的窗口。 */
  readonly onSent: (messageId: number) => void;
}

/** 发送表单提示消息。 */
export function sendQaForm({
  chatId,
  text,
  replyToMessageId,
  messageThreadId,
  onSent,
}: SendQaFormParams): Promise<number | undefined> {
  return sendMessage({
    chatId,
    text,
    replyToMessageId,
    messageThreadId,
    onSent,
  });
}

/**
 * 就地改写表单正文，让它上面那两行「已收到」等于会话当前状态。
 *
 * 表单会一直留到填齐、TTL 到期或群 teardown（见文件头注），而「收下了哪一样」
 * 的那条回执走命令文本的 30 秒清理。不回写的话，中途回来的人从表单上读到的
 * 永远是两项皆空，只能靠重发去试自己填到哪了；同一条消息里一项超长、另一项
 * 合规时更明显——合规那项已经进了会话，表单却只字不提。
 *
 * 改写而不是重发：表单 id 是状态机持有的删除责任（`session.formMessageId`），
 * 重发会让旧那条失去唯一的删除路径，永远留在群里。
 *
 * id 还没登记上（发送中被 abort）时什么都不做；改写失败留在 editMessageText 的
 * 统一错误边界，不影响本次认领——表单正文是提示层，权威状态在会话里。调用方
 * 必须 await：它和同一条 update 上的删除、回执是同一次交互的三步，改成
 * fire-and-forget 就成了一个没有 owner 等待的在途 Telegram 请求，停机排空看不见它。
 */
export async function editQaForm(session: QaFormSession, text: string): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  await editMessageText({ chatId: session.chatId, messageId, text });
}

/** 删除表单消息；id 还没登记上（发送中被 abort）时什么都不做。 */
export async function deleteQaForm(session: QaFormSession): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  session.formMessageId = undefined;
  await deleteMessageWithOutcome(session.chatId, messageId);
}
