import type { MaybeInaccessibleMessage, Message, Update } from "grammy/types";
import type { UpdateTopic } from "../types/lifecycle";

/**
 * 论坛（topics）群里这条消息所属话题的 `message_thread_id`。
 *
 * **只认 `is_topic_message` 为真的这一种来源**：`message_thread_id` 有两个来源——
 * 论坛话题，和关联频道讨论组的评论线程（见 antiRaid/updateIngress.ts 的同一条判定）。
 * Bot API 的 `message_thread_id` 发送参数只对 forum supergroup 有效，把评论线程的
 * 那个 id 当话题传上去会返回 400。讨论组的评论仍由 `reply_parameters` 决定落点。
 *
 * **General 话题恒为 undefined**：论坛群里发在 General 的消息不带
 * `message_thread_id`，因此原样镜像回去（不带这个参数）正好落回 General——
 * 「没有话题」与「General」在 Bot API 里本来就是同一件事。
 *
 * **入群验证提醒不走这里（显式豁免）**：回复式提醒（workers/antiRaid/
 * verificationReminders.ts 的 sendReplyReminder）锚在待验证成员刚发出的消息上，
 * 那条消息在论坛群里确实在某个话题里，锚被删掉时提醒会掉进 General。提醒不带
 * 话题，由状态机在验证结算时删除（verificationEffects.ts 的
 * replyReminderMessageId 分支），寿命上限是 VERIFICATION_TIMEOUT_MS（3 分钟），
 * 未送达的极端情形也只到 VERIFICATION_REMINDER_UNDELIVERED_MAX_MS（15 分钟）。
 * Worker 重建后由 ensurePendingReminder 用快照里的 welcomeAnchorMessageId 重发，
 * 同样不带话题。
 *
 * 这条豁免随入群验证的持久化格式下次因别的原因升版时重新评估。
 *
 * @returns 论坛话题内的消息返回该话题 id；General、非论坛群、讨论组评论一律
 *   返回 undefined，调用方据此不设置 `message_thread_id`。
 */
export function forumTopicThreadId(message: Message): number | undefined {
  return message.is_topic_message === true ? message.message_thread_id : undefined;
}

/**
 * 一条 update 的触发消息所在的论坛话题：触发消息取 message、channel_post 或按钮
 * 所在的那条消息（已不可访问的除外）。触发消息不在论坛话题里、或 update 没有
 * 触发消息（成员变动、反应、inline）时返回 undefined，不分配对象。
 */
export function updateTopicOf(update: Update): UpdateTopic | undefined {
  let message: Message | undefined = update.message ?? update.channel_post;
  if (message === undefined) {
    const callbackMessage: MaybeInaccessibleMessage | undefined = update.callback_query?.message;
    if (callbackMessage === undefined || callbackMessage.date === 0) return undefined;
    message = callbackMessage;
  }
  const threadId: number | undefined = forumTopicThreadId(message);
  return threadId === undefined ? undefined : { chatId: message.chat.id, threadId };
}

/**
 * 这条消息显式回复的那条消息；没有显式回复时返回 undefined。
 *
 * Bot API 对论坛（topics）群非 General 话题里**没有显式回复**的消息，同样填上
 * `reply_to_message`，指向该话题的创建服务消息：它带 `forum_topic_created`，
 * `message_id` 等于本条的 `message_thread_id`。两种形态任一命中都按「没有回复」
 * 处理；第二种只在 `is_topic_message === true` 时成立。
 *
 * 关联频道讨论组的评论线程不是论坛话题（`is_topic_message` 不为 true），顶层评论
 * 的 `reply_to_message` 是频道贴的自动转发，其 `message_id` 同样等于
 * `message_thread_id`，这里照常把它当作显式回复返回（见 docs/cn/04-invariants.md
 * 的讨论组评论约定）。
 *
 * 命令目标解析、`/permission query`、`/gag`、`/translate stop` 与 AI 触发事实里
 * 「用户回复了某条消息」的判定统一走这里。
 */
export function explicitReplyTo(message: Message): Message | undefined {
  const repliedTo: Message | undefined = message.reply_to_message;
  if (repliedTo === undefined || repliedTo.forum_topic_created !== undefined) return undefined;
  if (message.is_topic_message === true && repliedTo.message_id === message.message_thread_id) {
    return undefined;
  }
  return repliedTo;
}
