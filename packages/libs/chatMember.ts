import type { ChatMember } from "@grammyjs/types";
import type { BotChatPermissions } from "../types/telegram";

/** Telegram 管理员身份判定；普通 member 的在群判定语义不属于这里。 */
export function isAdminStatus(status: ChatMember["status"]): boolean {
  return status === "administrator" || status === "creator";
}

/**
 * 这份成员记录是否带着封禁成员的权限。
 *
 * 群主（creator）恒为真；普通管理员看 `can_restrict_members`——「是管理员」与
 * 「能封人」是两回事，黑名单处置卡住最常见的原因正是被授予了管理员却没勾这
 * 一项。其余身份一律为假。
 */
export function canRestrictMembers(member: ChatMember): boolean {
  if (member.status === "creator") return true;
  return member.status === "administrator" && member.can_restrict_members === true;
}

/**
 * 把一份 ChatMember 收敛成机器人自己那几个「能不能对别人动手」的权限位。
 *
 * 语义与上面的 canRestrictMembers 同源：群主恒为真，普通管理员逐项看自己的
 * 开关，其余身份一律为假。调用方拿它填 packages/cache/main/botAdmin.ts 的权限
 * 缓存，在发请求之前判断禁言/踢人/删消息做不做得成。
 */
export function readBotChatPermissions(member: ChatMember): BotChatPermissions {
  return {
    canRestrictMembers: canRestrictMembers(member),
    canDeleteMessages: member.status === "creator" ||
      (member.status === "administrator" && member.can_delete_messages === true),
  };
}
