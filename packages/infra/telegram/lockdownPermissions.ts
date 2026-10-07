import type { ChatPermissions, ChatFullInfo } from "grammy/types";
import type { TelegramApi } from "../../types/telegramWorker";
import { INDEPENDENT_CHAT_PERMISSIONS_OTHER } from "../../consts/telegram";

type LockdownPermissionsApi = Pick<TelegramApi, "getChat" | "setChatPermissions">;

export interface RestoreLockdownInvitePermissionParams {
  chatId: number;
  originalPermissions: ChatPermissions;
  api: LockdownPermissionsApi;
}

/**
 * 恢复 Anti-Raid 私密模式拥有的邀请权限。其它权限一律以 Telegram 当前
 * 值为准；管理员已手动重新开启邀请时也保留该决定。
 *
 * 「以当前值为准」依赖 `use_independent_chat_permissions`：不带时 Bot API 按蕴含规则
 * 把读回来的 `can_send_other_messages: true` 展开成一整排媒体权限
 * （见 consts/telegram.ts 的 INDEPENDENT_CHAT_PERMISSIONS_OTHER）。
 *
 * 该边界同时供 Worker 正常恢复和主线程 onGiveUp 紧急恢复使用。
 */
export async function restoreLockdownInvitePermission({
  chatId,
  originalPermissions,
  api,
}: RestoreLockdownInvitePermissionParams): Promise<void> {
  const chat: ChatFullInfo = await api.getChat(chatId);
  if (!("permissions" in chat) || !chat.permissions) {
    throw new Error(`Chat ${chatId} getChat response missing permissions`);
  }
  const currentPermissions: ChatPermissions = chat.permissions;
  const restoredInvite: boolean = currentPermissions.can_invite_users === true ||
    originalPermissions.can_invite_users === true;
  await api.setChatPermissions(
    chatId,
    {
      ...currentPermissions,
      can_invite_users: restoredInvite,
    },
    INDEPENDENT_CHAT_PERMISSIONS_OTHER
  );
}
