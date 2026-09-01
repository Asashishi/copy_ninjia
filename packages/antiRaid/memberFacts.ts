import {
  hasWhitelistPermission,
  isWhitelisted,
} from "../infra/identityPolicy/whitelist";
import { isAdminStatus } from "../libs/chatMember";
import type { ChatMember } from "grammy/types";
import type { AntiRaidMember } from "../types/antiRaid/protocol";

/**
 * 从 grammY 的 ChatMember/User 对象里提取入群守卫需要的几个事实。纯函数、
 * 无 I/O，供 antiRaid/updateIngress.ts 的 chat_member 与服务消息两条路径共用。
 */

/**
 * 自己人：不得进入自动处置产生的永久黑名单。
 *
 * `SUPER_ADMIN_USER_ID` 与 SQLite 永久白名单是部署方明确登记的身份，两者都由
 * isWhitelisted 一并覆盖（超级管理员恒在白名单边界内，见 whitelist.ts）。
 * 临时白名单只持有广告检测豁免，不进入本边界；广告检测在调用本函数前先按
 * isCanBypassAdDetection 复查。防刷屏另受 isCanBypassFloodControl 控制。
 */
export function isProtectedSender(senderId: number): boolean {
  return isWhitelisted(senderId);
}

/** 广告检测专用豁免：只按当前有效权限的广告检测单项决定。 */
export function canBypassAdDetection(
  senderId: number,
  now?: number
): boolean {
  return hasWhitelistPermission(
    senderId,
    "isCanBypassAdDetection",
    now
  );
}

/** 防刷屏专用豁免：永久白名单按逐项权限决定，超级管理员恒持有该权限。 */
export function canBypassFloodControl(senderId: number): boolean {
  return isWhitelisted(senderId) &&
    hasWhitelistPermission(senderId, "isCanBypassFloodControl");
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
