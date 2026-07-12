import type { ChatPermissions } from "@grammyjs/types";

/** 反刷群私密模式（src/antiRaid.ts）的内存状态。 */

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

// 均仅存于内存中，符合需求——计数窗口和私密模式状态都不需要在重启后保留。
export const joinWindows: Map<number, JoinWindow> = new Map();
export const activeLockdowns: Map<number, Lockdown> = new Map();
