/**
 * 群问答直答：文本与登记的问题**完全一致**时直接回答，不经过 AI。
 *
 * 这条判定挂在每条群消息的主干上，因此第一步就必须便宜到可以忽略：
 * `getChatQa(chatId)` 对没登记过问答的群返回 undefined，整条路径到此为止，
 * 零分配、零字符串操作。只有真的开了问答的群才会走到查表那一步，而那一步
 * 也是拿 `message.text` 原串直接 `Map.get`，同样不产生任何中间对象——问题文本
 * 在**写入时**就 trim 好了，热路径不做归一化。
 *
 * 唯一会分配的分支是「首个实体是指向本机器人的 @提及」：那时才折两次大小写比对
 * 用户名、再切一次前缀查一次。@ 和回复同样走直答（用户明确要求），因此这条判定
 * 必须排在 AI 触发之前。语义相近但文本不同的提问不归这里，交给模型的
 * group_qa_answer。
 */

import type { Message, MessageEntity } from "grammy/types";
import { sendMessage } from "../../infra/telegram";
import { getChatQa } from "../../infra/qaStore";
import { renderFencedText } from "../../libs/codeFence";
import type { RichTextMessage } from "../../types/telegram";

/**
 * 首个实体正好是从 0 开始的 @提及时返回它的长度，否则 0。
 *
 * 只看第一个实体、只认 offset 0：`@bot 怎么入群？` 与登记的 `怎么入群？` 是同一
 * 个问题，而 `问 @bot 怎么入群？` 不是——后者的提及在句中，切掉它会得到一个
 * 用户从没打出来过的串。
 *
 * 用户名比对折大小写，与 infra/updateGate.ts、auto/message/facts.ts、
 * commands/cjkAction.ts 的口径一致：Telegram 用户名本身大小写不敏感，手打
 * `@copy_ninjia_bot` 与规范的 `@Copy_Ninjia_Bot` 是同一个提及，两者都会生成
 * mention 实体。只折用户名，**不折问题文本**——问题仍要求一字不差。
 */
function leadingBotMentionLength(message: Message, botUsername: string): number {
  const entities: readonly MessageEntity[] | undefined = message.entities;
  const first: MessageEntity | undefined = entities?.[0];
  if (first?.offset !== 0 || first.type !== "mention") return 0;
  const text: string | undefined = message.text;
  if (text === undefined) return 0;
  // mention 实体的正文含前导 @，与 botUsername 比对时要跳过它；长度由实体自己
  // 划定，因此 `@bot2` 这类同前缀更长的名字不会被误认成本机器人。
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
  // 绝大多数群在这一行就走开：没登记过问答的群连 message.text 都不会被读。
  const entries: ReadonlyMap<string, string> | undefined = getChatQa(chatId);
  if (entries === undefined) return undefined;
  const text: string | undefined = message.text;
  if (text === undefined) return undefined;
  // 原串直查，零分配；绝大多数命中都在这一步完成。
  const direct: string | undefined = entries.get(text);
  if (direct !== undefined) return direct;
  const mentionLength: number = leadingBotMentionLength(message, botUsername);
  if (mentionLength === 0) return undefined;
  // 上一行的用户名比对已经切过一次前缀、折过两次大小写；这里再切一次拿正文。
  // 整条尾巴只在「本群有问答 + 原串没命中 + 首实体是前导 @提及」时才走到。
  return entries.get(text.slice(mentionLength).trim());
}

/** sendQaDirectAnswer 的入参；话题 id 让第四项越过位置参数上限，故收成 options。 */
export interface SendQaDirectAnswerParams {
  readonly chatId: number;
  readonly replyToMessageId: number;
  readonly answer: string;
  /**
   * 提问所在的论坛话题；调用方用 forumTopicThreadId 从原消息取。
   *
   * 答案长期留在群里（见下），因此不能只靠 reply_parameters 定位：提问被删时
   * `allow_sending_without_reply` 会把这条降级成普通发送，那时只剩这个参数还
   * 留在话题里（见 SendMessageParams.messageThreadId）。
   */
  readonly messageThreadId: number | undefined;
}

/**
 * 把命中的答案发进群。
 *
 * **刻意不把「判定 + 发送」合成一个 async 函数**：那样每条群消息都要为一次注定
 * 落空的判定分配一个 promise 并 await 它。判定留在同步的 resolveQaDirectAnswer
 * 里，调用方只在真的拿到答案时才进这条异步路径。
 *
 * 答案里的 ``` 围栏在这里拆回 `pre` 实体（见 libs/codeFence.ts），用户当初粘进
 * 表单的那块 ```json 才会原样渲染成可复制的代码块；没有围栏的答案在渲染的第一
 * 行就走开，不产生任何中间对象。
 *
 * 回答用 sendMessage 而不是 sendCommandMessage：这是本群自己登记的功能性内容，
 * 不是命令的非功能性提示，不该在 30 秒后被收走——问的人还没读完就没了。
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
