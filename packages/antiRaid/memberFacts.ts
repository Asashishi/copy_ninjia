import { PRIVILEGED_USERS_ID, SUPER_ADMIN_USER_ID } from "../infra/config";
import { isAdminStatus } from "../libs/chatMember";
import type { ChatMember } from "@grammyjs/types";
import type { AntiRaidMember } from "../types/antiRaid";

/**
 * 从 grammY 的 ChatMember/User 对象里提取入群守卫需要的几个事实。纯函数、
 * 无 I/O，供 antiRaid/index.ts 的 chat_member 与服务消息两条路径共用。
 */

/**
 * 自己人：不参与任何自动处置，也不该被送进判定。
 *
 * `SUPER_ADMIN_USER_ID` 与 `PRIVILEGED_USERS_ID` 是部署方亲手写进 `.env` 的两批
 * 身份，机器人自动作出的判断（广告命中、刷屏计数）不该反过来收拾他们——广告
 * 那条处置更是不可逆的（见 docs/04-invariants.md）。判定收在这里一处，别让
 * 每个自动处置各写一份、迟早有一处漏掉其中一批。
 */
export function isProtectedSender(senderId: number): boolean {
  return senderId === SUPER_ADMIN_USER_ID || PRIVILEGED_USERS_ID.includes(senderId);
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
