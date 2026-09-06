/**
 * 表单发送、编辑和删除的唯一 Telegram 边界。
 * 表单由结算、TTL、重开或 teardown 清理，不挂固定延迟删除；见 docs/cn/04-invariants.md。
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
  /** 远端返回 id 后同步登记，已关闭会话的迟到消息交回状态机清理。 */
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

/** 就地更新当前表单；等待请求完成以纳入 update 排空，失败由 Telegram 边界记录。 */
export async function editQaForm(session: QaFormSession, text: string): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  await editMessageText({ chatId: session.chatId, messageId, text });
}

/** 交出消息 id 的唯一删除责任；id 尚未登记时由迟到发送回调继续清理。 */
export async function deleteQaForm(session: QaFormSession): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  session.formMessageId = undefined;
  await deleteMessageWithOutcome(session.chatId, messageId);
}
