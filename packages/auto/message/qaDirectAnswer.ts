/**
 * 群问答直答：文本与登记的问题完全一致时直接回答，不经过 AI。
 *
 * 判定位于每条群消息的主干：`chatQaEntries.get(chatId)`（cache/main/qa.ts，只读）对没登记过问答的群
 * 返回 undefined，整条路径到此为止，零分配、零字符串操作。开了问答的群用 `message.text` 原串直接
 * `Map.get`，不产生中间对象；问题文本在写入时已 trim，热路径不做归一化。
 *
 * 唯一会分配的分支是「首个实体是指向本机器人的 @提及」：折两次大小写比对用户名，再切一次前缀查表。
 * @ 和回复同样走直答，这条判定排在 AI 触发之前。语义相近但文本不同的提问不归这里，
 * 交给模型的 group_qa_answer。
 */

import type { Message, MessageEntity } from "grammy/types";
import { sendMessage } from "../../infra/telegram";
import { chatQaEntries } from "../../cache/main/qa";
import { renderFencedText } from "../../libs/codeFence";
import type { RichTextMessage } from "../../types/telegram";

/**
 * 首个实体正好是从 0 开始的 @提及时返回它的长度，否则 0。
 *
 * 只看第一个实体、只认 offset 0：`@bot 怎么入群？` 按登记的 `怎么入群？` 直答，
 * 句中的提及（`问 @bot 怎么入群？`）不处理。
 *
 * 用户名比对折大小写，口径同 infra/updateGate.ts、auto/message/facts.ts、
 * commands/cjkAction.ts；问题文本不折大小写，仍要求一字不差。
 */
function leadingBotMentionLength(message: Message, botUsername: string): number {
  const entities: readonly MessageEntity[] | undefined = message.entities;
  const first: MessageEntity | undefined = entities?.[0];
  if (first?.offset !== 0 || first.type !== "mention") return 0;
  const text: string | undefined = message.text;
  if (text === undefined) return 0;
  // mention 实体的正文含前导 @，比对时跳过它；长度取实体自己的长度，
  // `@bot2` 这类同前缀更长的名字不匹配。
  if (text.slice(1, first.length).toLowerCase() !== botUsername.toLowerCase()) return 0;
  return first.length;
}

/**
 * 查出这条消息应当直答的答案。
 *
 * @returns 命中时是答案文本；未命中（含本群没有问答）时是 undefined，调用方
 *   照常继续原有流水线。
 */
export function resolveQaDirectAnswer(
  chatId: number,
  message: Message,
  botUsername: string
): string | undefined {
  // 没登记过问答的群在这一行返回，不读取 message.text。
  const entries: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  if (entries === undefined) return undefined;
  const text: string | undefined = message.text;
  if (text === undefined) return undefined;
  // 原串直查，零分配。
  const direct: string | undefined = entries.get(text);
  if (direct !== undefined) return direct;
  const mentionLength: number = leadingBotMentionLength(message, botUsername);
  if (mentionLength === 0) return undefined;
  // 只在「本群有问答 + 原串没命中 + 首实体是前导 @提及」时走到这里：
  // 切掉提及前缀后取正文再查。
  return entries.get(text.slice(mentionLength).trim());
}

/** sendQaDirectAnswer 的入参。 */
export interface SendQaDirectAnswerParams {
  readonly chatId: number;
  readonly replyToMessageId: number;
  readonly answer: string;
  /**
   * 提问所在的论坛话题；调用方用 forumTopicThreadId 从原消息取。
   * 发送时同时带 reply_parameters 与该话题（见 SendMessageParams.messageThreadId），
   * 提问被删而降级成普通发送时仍留在话题内。
   */
  readonly messageThreadId: number | undefined;
}

/**
 * 把命中的答案发进群。
 *
 * 判定留在同步的 resolveQaDirectAnswer 里，调用方拿到答案才进入这条异步发送路径。
 *
 * 答案里的 ``` 围栏在这里拆回 `pre` 实体（见 libs/codeFence.ts），渲染成可复制的代码块；
 * 没有围栏的答案在渲染的第一行返回，不产生中间对象。
 *
 * 回答用 sendMessage（不用 sendCommandMessage）：它是本群登记的功能性内容，
 * 不挂固定延迟删除。
 */
export function sendQaDirectAnswer({
  chatId,
  replyToMessageId,
  answer,
  messageThreadId,
}: SendQaDirectAnswerParams): Promise<number | undefined> {
  const rendered: RichTextMessage = renderFencedText(answer);
  return sendMessage({
    chatId,
    text: rendered.text,
    entities: rendered.entities,
    replyToMessageId,
    messageThreadId,
  });
}
