import type { BotActionPermissions, BotChatPermissions } from "../types/telegram";

/** 机器人自身管理员身份与权限位追踪（packages/infra/botAdmin.ts）的调参常量。 */

/**
 * `ChatState.botPermissions` 的完整字段集与稳定序列化顺序。
 * 解码、等值判定和「非管理员必须全 false」校验共用它，任一读写口
 * 不得另写一份会漂移的字段清单。
 */
export const BOT_CHAT_PERMISSION_KEYS: readonly (keyof BotChatPermissions)[] = [
  "isAdministrator",
  "isAnonymous",
  "canManageChat",
  "canDeleteMessages",
  "canManageVideoChats",
  "canRestrictMembers",
  "canPromoteMembers",
  "canChangeInfo",
  "canInviteUsers",
  "canManageTags",
  "canPostStories",
  "canEditStories",
  "canDeleteStories",
  "canPostMessages",
  "canEditMessages",
  "canPinMessages",
  "canManageTopics",
  "canManageDirectMessages",
];

/**
 * 这份快照里**下游 Anti-Raid Worker 真正读的**那两位（见 types/telegram.ts 的
 * `BotActionPermissions`）。
 *
 * 与上面那张全字段表分开的理由：`my_chat_member` 对机器人自身成员记录的任何改动都会
 * 送达，而其余 16 位本仓库一处都不读——按全表判等去广播，等于每次勾掉一个无关权限
 * 都往 Worker mailbox 里投一条与上一条逐字节相同的消息。投影与广播去重共用这一份清单
 * （见 libs/chatMember.ts），两处不再各写一份会漂移的字段集。
 */
export const BOT_ACTION_PERMISSION_KEYS: readonly (keyof BotActionPermissions)[] = [
  "canRestrictMembers",
  "canDeleteMessages",
];

/**
 * 一次没能确证权限位的现查之后，同一个群多久才允许再现查一次。
 *
 * 权限位的按需补齐挂在群消息热路径上（见 `ensureBotChatPermissions`）：成功一次
 * 就写入 State 快照，此后由 `my_chat_member` 维护，因此正常情况下这道退避根本用不到。
 * 它兜的是状态快照缺失或 `getChatMember` 持续
 * 失败这类退化路径——没有退避的话，那种群里每条消息都会换来一次注定失败的
 * 现查，一个刷屏号就能把限流队列打满。
 */
export const BOT_PERMISSION_PROBE_RETRY_MS: number = 5 * 60_000;
