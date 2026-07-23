import type { ChatPermissions } from "@grammyjs/types";
import type { Api } from "grammy";

type LockdownPermissionsApi = Pick<Api, "getChat" | "setChatPermissions">;

/**
 * 恢复 Anti-Raid 私密模式拥有的邀请权限。其它默认权限一律以 Telegram 当前
 * 值为准，避免覆盖管理员在锁定期间对媒体、投票等字段的并发修改；管理员已
 * 手动重新开启邀请时也保留该显式决定。
 *
 * 该边界同时供 Worker 正常恢复和主线程 onGiveUp 紧急恢复使用，保证两条
 * 路径不会逐渐产生不同的权限合并语义。
 */
export interface RestoreLockdownInvitePermissionParams {
  chatId: number;
  originalPermissions: ChatPermissions;
  api: LockdownPermissionsApi;
}

export async function restoreLockdownInvitePermission({
  chatId,
  originalPermissions,
  api,
}: RestoreLockdownInvitePermissionParams): Promise<void> {
  const chat = await api.getChat(chatId);
  if (!("permissions" in chat) || !chat.permissions) {
    throw new Error(`Chat ${chatId} getChat response missing permissions`);
  }
  const currentPermissions: ChatPermissions = chat.permissions;
  const restoredInvite: boolean = currentPermissions.can_invite_users === true ||
    originalPermissions.can_invite_users === true;
  await api.setChatPermissions(chatId, {
    ...currentPermissions,
    can_invite_users: restoredInvite,
  });
}
