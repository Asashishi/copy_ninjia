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
 * 权限位的中文名。`/bot_status` 的权限块只列**已经拥有**的位，缺权限提示点名
 * 机器人缺的那一位（见 libs/botPermissionGap.ts）；两处读同一张表，同一位在
 * 群里只有一个叫法。
 *
 * 字段全集与展示顺序以 BOT_CHAT_PERMISSION_KEYS 为准，这里只补名字；新增权限位时
 * 两处都要加，缺了会在类型层报错。
 */
export const BOT_CHAT_PERMISSION_LABELS: Readonly<
  Record<keyof BotChatPermissions, string>
> = {
  isAdministrator: "管理员身份",
  isAnonymous: "匿名身份",
  canManageChat: "管理聊天",
  canDeleteMessages: "删除消息",
  canManageVideoChats: "管理视频聊天",
  canRestrictMembers: "限制与封禁成员",
  canPromoteMembers: "任免管理员",
  canChangeInfo: "修改聊天资料",
  canInviteUsers: "邀请用户",
  canManageTags: "管理成员标签",
  canPostStories: "发布故事",
  canEditStories: "编辑故事",
  canDeleteStories: "删除故事",
  canPostMessages: "频道发布消息",
  canEditMessages: "编辑频道消息",
  canPinMessages: "置顶消息",
  canManageTopics: "管理论坛话题",
  canManageDirectMessages: "管理频道私信",
};

/**
 * 这份快照里**下游 Anti-Raid Worker 真正读的**那两位（见 types/telegram.ts 的
 * `BotActionPermissions`）；其余 16 位 Worker 不读。投影与广播去重共用这一份
 * 清单（见 libs/chatMember.ts），不另写一份会漂移的字段集。
 */
export const BOT_ACTION_PERMISSION_KEYS: readonly (keyof BotActionPermissions)[] = [
  "canRestrictMembers",
  "canDeleteMessages",
];

/**
 * 一次没能确证权限位的现查之后，同一个群多久才允许再现查一次。
 *
 * 权限位的按需补齐挂在群消息热路径上（见 `ensureBotChatPermissions`）：成功一次
 * 就写入 State 快照，此后由 `my_chat_member` 维护，正常情况下这道退避不会触发；
 * 它只在状态快照缺失或 `getChatMember` 持续失败时限制现查频率。
 */
export const BOT_PERMISSION_PROBE_RETRY_MS: number = 5 * 60_000;
