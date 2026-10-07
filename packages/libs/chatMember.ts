import type { ChatMember } from "grammy/types";
import type { BotActionPermissions, BotChatPermissions } from "../types/telegram";
import {
  BOT_ACTION_PERMISSION_KEYS,
  BOT_CHAT_PERMISSION_KEYS,
} from "../consts/botAdmin";

/** Telegram 管理员身份判定；普通 member 的在群判定语义不属于这里。 */
export function isAdminStatus(status: ChatMember["status"]): boolean {
  return status === "administrator" || status === "creator";
}

/**
 * 这份成员记录是否带着封禁成员的权限。
 *
 * 群主（creator）恒为真；普通管理员看 `can_restrict_members`。其余身份一律为假。
 */
function canRestrictMembers(member: ChatMember): boolean {
  if (member.status === "creator") return true;
  return member.status === "administrator" && member.can_restrict_members === true;
}

/**
 * 把一份 ChatMember 收敛成机器人自己的完整管理员权限快照。
 *
 * 群主按 Telegram 「拥有全部管理权限」的定义收敛为全权限 true；普通
 * 管理员逐项读 `grammy/types` 声明的字段，可选字段缺省明确收敛为 false；
 * 其余身份保留一份全 false 快照。调用方整体替换 State 中的旧快照，不就地修改字段。
 */
export function readBotChatPermissions(member: ChatMember): BotChatPermissions {
  const isAdministrator: boolean = isAdminStatus(member.status);
  const isOwner: boolean = member.status === "creator";
  return {
    isAdministrator,
    isAnonymous: member.status === "creator" || member.status === "administrator"
      ? member.is_anonymous === true
      : false,
    canManageChat: isOwner || (member.status === "administrator" && member.can_manage_chat === true),
    canDeleteMessages: isOwner || (member.status === "administrator" && member.can_delete_messages === true),
    canManageVideoChats: isOwner ||
      (member.status === "administrator" && member.can_manage_video_chats === true),
    canRestrictMembers: canRestrictMembers(member),
    canPromoteMembers: isOwner || (member.status === "administrator" && member.can_promote_members === true),
    canChangeInfo: isOwner || (member.status === "administrator" && member.can_change_info === true),
    canInviteUsers: isOwner || (member.status === "administrator" && member.can_invite_users === true),
    canManageTags: isOwner || (member.status === "administrator" && member.can_manage_tags === true),
    canPostStories: isOwner || (member.status === "administrator" && member.can_post_stories === true),
    canEditStories: isOwner || (member.status === "administrator" && member.can_edit_stories === true),
    canDeleteStories: isOwner || (member.status === "administrator" && member.can_delete_stories === true),
    canPostMessages: isOwner || (member.status === "administrator" && member.can_post_messages === true),
    canEditMessages: isOwner || (member.status === "administrator" && member.can_edit_messages === true),
    canPinMessages: isOwner || (member.status === "administrator" && member.can_pin_messages === true),
    canManageTopics: isOwner || (member.status === "administrator" && member.can_manage_topics === true),
    canManageDirectMessages: isOwner ||
      (member.status === "administrator" && member.can_manage_direct_messages === true),
  };
}

/** 逐位比较两份完整权限快照；用于去重 State 落盘。 */
export function botChatPermissionsEqual(
  left: Readonly<BotChatPermissions> | undefined,
  right: Readonly<BotChatPermissions> | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  for (const key of BOT_CHAT_PERMISSION_KEYS) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** 把完整快照收敛成投递给 Worker 的那两位（字段集见 consts/botAdmin.ts）。 */
export function projectBotActionPermissions(
  permissions: Readonly<BotChatPermissions>
): BotActionPermissions {
  return {
    canRestrictMembers: permissions.canRestrictMembers,
    canDeleteMessages: permissions.canDeleteMessages,
  };
}

/**
 * 只比 BOT_ACTION_PERMISSION_KEYS 投影后的位，其余权限位的变化不产生投递
 * （见 infra/botAdmin.ts 的 recordBotChatPermissions）。
 */
export function botActionPermissionsEqual(
  left: Readonly<BotChatPermissions> | undefined,
  right: Readonly<BotChatPermissions> | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  for (const key of BOT_ACTION_PERMISSION_KEYS) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** 当前成员状态判定：restricted 必须同时满足 is_member。 */
export function isPresentMember(member: ChatMember): boolean {
  if (member.status === "restricted") return member.is_member;
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member"
  );
}
