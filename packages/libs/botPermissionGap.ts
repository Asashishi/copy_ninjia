import { BOT_CHAT_PERMISSION_LABELS } from "../consts/botAdmin";
import type { AtmosphereNotices } from "../types/atmosphereNotices";
import type { BotChatPermissions } from "../types/telegram";

/**
 * 机器人缺某项权限时给群里的原因短语：快照缺失说「没查清」，确证不是管理员说
 * 「不是管理员」，确证是管理员则点名缺的那一位。该位已具备时返回 undefined。
 *
 * 快照缺失只表示未确证（见 infra/botAdmin.ts 的 `botChatPermissionsIn`），不得说成
 * 不是管理员；是管理员但缺权限位时也不得笼统说成不是管理员。
 */
export function describeBotPermissionGap(
  permissions: Readonly<BotChatPermissions> | undefined,
  permission: Exclude<keyof BotChatPermissions, "isAdministrator" | "isAnonymous">,
  notices: Readonly<AtmosphereNotices>
): string | undefined {
  if (permissions === undefined) return notices.botPermissionUnknown;
  if (permissions[permission]) return undefined;
  const label: string = BOT_CHAT_PERMISSION_LABELS[permission];
  return permissions.isAdministrator
    ? notices.botMissingPermission(label)
    : notices.botNotAdministrator(label);
}
