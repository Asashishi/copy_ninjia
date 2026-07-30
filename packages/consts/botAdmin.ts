/** 机器人自身管理员身份与权限位追踪（packages/infra/botAdmin.ts）的调参常量。 */

/**
 * 一次没能确证权限位的现查之后，同一个群多久才允许再现查一次。
 *
 * 权限位的按需补齐挂在群消息热路径上（见 `ensureBotChatPermissions`）：成功一次
 * 就永久缓存，此后由 `my_chat_member` 维护，因此正常情况下这道退避根本用不到。
 * 它兜的是「`state.json` 里记着是管理员、实际已经不是」或 `getChatMember` 持续
 * 失败这类退化路径——没有退避的话，那种群里每条消息都会换来一次注定失败的
 * 现查，一个刷屏号就能把限流队列打满。
 */
export const BOT_PERMISSION_PROBE_RETRY_MS: number = 5 * 60_000;
