import type { ChatMember } from "@grammyjs/types";

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
