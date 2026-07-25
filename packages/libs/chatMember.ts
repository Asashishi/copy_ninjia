import type { ChatMember } from "@grammyjs/types";

/** Telegram 管理员身份判定；普通 member 的在群判定语义不属于这里。 */
export function isAdminStatus(status: ChatMember["status"]): boolean {
  return status === "administrator" || status === "creator";
}
