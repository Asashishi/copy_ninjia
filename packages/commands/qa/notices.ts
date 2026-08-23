/**
 * `/set_qa` 按钮表单的 Telegram 动作边界。
 *
 * 表单是**状态机拥有的按钮消息**，与入群验证按钮同类：它只能由「两项填齐」、
 * TTL 到期或群 teardown 这三条状态机路径删除，不能挂命令文本那条固定 30 秒
 * 清理——用户正在照着按钮填，消息却在 30 秒后自己消失。因此这里直接用
 * sendMessage，并在 scripts/checkProjectConventions.ts 里登记了对应豁免。
 */

import { InlineKeyboard } from "grammy";
import {
  QA_ANSWER_BUTTON_TEXT,
  QA_INLINE_ANSWER_PREFIX,
  QA_INLINE_QUESTION_PREFIX,
  QA_QUESTION_BUTTON_TEXT,
} from "../../consts/qa";
import { deleteMessageWithOutcome, sendMessage } from "../../infra/telegram";
import type { QaFormSession } from "../../types/qa";

/**
 * 两个按钮都用 switchInlineCurrent 预填当前输入框。
 *
 * 前缀里带群 id 只是为了让两条 inline 查询各自可解析；**它不承担任何鉴权**：
 * 落群后认领与否，完全由 Telegram 给出的 `message.chat.id`、`from.id` 与
 * `via_bot` 决定（见 qa/inline.ts）。伪造前缀指向别的群，结果仍然落在伪造者
 * 自己所在的那个群，届时对不上就被丢弃。
 */
function buildQaFormKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .switchInlineCurrent(QA_QUESTION_BUTTON_TEXT, `${QA_INLINE_QUESTION_PREFIX}${chatId} `)
    .switchInlineCurrent(QA_ANSWER_BUTTON_TEXT, `${QA_INLINE_ANSWER_PREFIX}${chatId} `);
}

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

/** 发送带两个按钮的表单消息。 */
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
    keyboard: buildQaFormKeyboard(chatId),
    onSent,
  });
}

/** 删除表单消息；id 还没登记上（发送中被 abort）时什么都不做。 */
export async function deleteQaForm(session: QaFormSession): Promise<void> {
  const messageId: number | undefined = session.formMessageId;
  if (messageId === undefined) return;
  session.formMessageId = undefined;
  await deleteMessageWithOutcome(session.chatId, messageId);
}
