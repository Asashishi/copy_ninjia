import type { BotChatPermissions } from "../../packages/types/telegram";

/**
 * 构造一份字段齐全的机器人管理员权限快照。默认是「已为管理员，
 * 但除通用管理能力外未授予其它动作权限」；单测只覆盖与用例相关的位。
 */
export function botPermissions(
  overrides: Partial<BotChatPermissions> = {}
): BotChatPermissions {
  return {
    isAdministrator: true,
    isAnonymous: false,
    canManageChat: true,
    canDeleteMessages: false,
    canManageVideoChats: false,
    canRestrictMembers: false,
    canPromoteMembers: false,
    canChangeInfo: false,
    canInviteUsers: false,
    canManageTags: false,
    canPostStories: false,
    canEditStories: false,
    canDeleteStories: false,
    canPostMessages: false,
    canEditMessages: false,
    canPinMessages: false,
    canManageTopics: false,
    canManageDirectMessages: false,
    ...overrides,
  };
}
