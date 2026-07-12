import type { ChatPermissions } from "@grammyjs/types";

export interface JoinWindow {
  count: number;
  resetTimeout: ReturnType<typeof setTimeout>;
}

export interface Lockdown {
  /**
   * 触发私密模式前的原始默认权限，用于到期后精确恢复——而不是简单把
   * can_invite_users 设回 true，避免覆盖管理员本来就设置的其他限制。
   */
  originalPermissions: ChatPermissions;
  restoreTimeout: ReturnType<typeof setTimeout>;
}
