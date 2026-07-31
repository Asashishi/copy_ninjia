import { SUPER_ADMIN_USER_ID } from "../infra/config";
import {
  hasWhitelistPermission,
  isWhitelisted,
} from "../config/whitelist";
import { isAdminStatus } from "../libs/chatMember";
import type { ChatMember } from "@grammyjs/types";
import type { AntiRaidMember } from "../types/antiRaid";

/**
 * 从 grammY 的 ChatMember/User 对象里提取入群守卫需要的几个事实。纯函数、
 * 无 I/O，供 antiRaid/index.ts 的 chat_member 与服务消息两条路径共用。
 */

/**
 * 自己人：不得进入自动处置产生的永久黑名单，也不参与刷屏计数。
 *
 * `SUPER_ADMIN_USER_ID` 与 config/whitelist.json 是部署方亲手配置的身份，
 * 广告检测送检另受 isCanBypassAdDetection 控制：关闭该权限的白名单成员仍可被
 * 判定并删除本批消息，但主线程处置会用本函数再次拒绝永久拉黑。
 */
export function isProtectedSender(senderId: number): boolean {
  return senderId === SUPER_ADMIN_USER_ID || isWhitelisted(senderId);
}

/** 广告检测专用豁免：超级管理员恒豁免，白名单按逐项权限决定。 */
export function canBypassAdDetection(senderId: number): boolean {
  return senderId === SUPER_ADMIN_USER_ID ||
    hasWhitelistPermission(senderId, "isCanBypassAdDetection");
}

export interface PickMemberParams {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

/** 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。 */
export function pickMember(user: PickMemberParams): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name, isBot: user.is_bot === true };
}

/** 某个 ChatMember 是否实际还在聊天中（相对于已离开/已被踢出而言）。 */
export function isActiveChatMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member;
  return true; // "member" | "administrator" | "creator"
}

/**
 * 只有身份可归因的非匿名管理员才提供“邀请者免验证”。匿名管理员仍是
 * Telegram 管理员，也仍可因自身管理员身份免验证；这里只避免把匿名操作
 * 可能携带的脱敏/共享 actor 身份当作可信邀请者。
 */
export function isInviterExemptAdmin(member: ChatMember): boolean {
  return isAdminStatus(member.status) && (!("is_anonymous" in member) || member.is_anonymous !== true);
}
