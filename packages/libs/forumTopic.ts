import type { Message } from "@grammyjs/types";

/**
 * 论坛（topics）群里这条消息所属话题的 `message_thread_id`。
 *
 * **为什么必须同时看 `is_topic_message`**：`message_thread_id` 有两个来源——论坛
 * 话题，和关联频道讨论组的评论线程（见 antiRaid/updateIngress.ts 的同一条判定）。
 * Bot API 的 `message_thread_id` 发送参数只对 forum supergroup 有效，把评论线程的
 * 那个 id 当话题传上去只会换一次 400，因此这里只认论坛话题这一种来源；讨论组的
 * 评论仍由 `reply_parameters` 决定落点。
 *
 * **General 话题恒为 undefined**：论坛群里发在 General 的消息不带
 * `message_thread_id`，因此原样镜像回去（不带这个参数）正好落回 General——
 * 「没有话题」与「General」在 Bot API 里本来就是同一件事。
 *
 * **入群验证提醒不走这里（显式豁免）**：回复式提醒（workers/antiRaid/
 * verificationReminders.ts 的 sendReplyReminder）锚在待验证成员刚发出的消息上，
 * 那条消息在论坛群里确实在某个话题里，锚被删掉时提醒会掉进 General。仍然不带
 * 话题，有两个原因，缺一不可：
 *
 * 1. **它会自己消失**。提醒由状态机在验证结算时删除（verificationEffects.ts 的
 *    replyReminderMessageId 分支），寿命上限是 VERIFICATION_TIMEOUT_MS（3 分钟），
 *    未送达的极端情形也只到 VERIFICATION_REMINDER_UNDELIVERED_MAX_MS（15 分钟）。
 *    「长期留存必须带话题」这条口径防的是**永久**错位，不是几分钟的错位。
 * 2. **补上它要改持久化格式**。提醒可以在 Worker 重建后由 ensurePendingReminder
 *    用快照里的 welcomeAnchorMessageId 重发，因此话题 id 也必须一起持久化——
 *    那要动 VERIFICATION_BASE_RECORD_KEYS 与待验证快照文件版本，按 AGENTS.md
 *    要占掉「上一个已发布版本 → 当前版本」那唯一一条冷迁移边（当前给了 chat_qa）。
 *    只在实时路径带、重建后不带的半吊子做法更糟：同一条提醒的落点会随进程是否
 *    重启过而变，比稳定地落 General 更难排查。
 *
 * 这条豁免随入群验证的持久化格式下次因别的原因升版时重新评估。
 *
 * @returns 论坛话题内的消息返回该话题 id；General、非论坛群、讨论组评论一律
 *   返回 undefined，调用方据此不设置 `message_thread_id`。
 */
export function forumTopicThreadId(message: Message): number | undefined {
  return message.is_topic_message === true ? message.message_thread_id : undefined;
}
