import {
  GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID,
  GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX,
  GAG_PROFILE_CHAT_SEPARATOR,
  GAG_PUBLIC_PROFILE_LINK_PREFIX,
  GAG_PUBLIC_PROFILE_QUERY,
  GAG_USER_PROFILE_LINK_PREFIX,
} from "../../consts/gag";
import {
  CHAT_ID_ARG_PATTERN,
  USER_ID_ARG_PATTERN,
  USERNAME_ARG_PATTERN,
} from "../../consts/commands";
import type { CachedUser } from "../../types/chatState";
import type { GagSession } from "../../types/gag";

/** 把 Bot API 的负频道 ID 转成 `t.me/c` 使用的不带 `-100` 命名空间前缀的 ID。 */
function privateChannelProfileId(targetId: number): string {
  const absoluteId: string = String(targetId).slice(1);
  return absoluteId.startsWith("100") ? absoluteId.slice(3) : absoluteId;
}

/**
 * 构造目标主页：公开身份优先使用 username；无 username 的用户使用官方 ID
 * profile link，频道则使用其 `t.me/c` 对话主页。
 */
export function createGagTargetProfileUrl(target: CachedUser): string {
  if (target.username !== undefined) {
    return `${GAG_PUBLIC_PROFILE_LINK_PREFIX}${target.username}` +
      GAG_PUBLIC_PROFILE_QUERY;
  }
  if (target.id > 0) {
    return `${GAG_USER_PROFILE_LINK_PREFIX}${target.id}`;
  }
  return GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX +
    privateChannelProfileId(target.id) +
    `/${GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID}`;
}

/**
 * 生成 inline 结果前缀所挂的隐藏 marker：主页绑定发言身份，fragment 绑定目标群。
 * URL 对最终用户可见，fragment 不是秘密或鉴权 token；落群时必须分别核对
 * Telegram 给出的 sender 与 chat，不能只信链接载荷。
 */
export function createGagInlineMarkerUrl(session: GagSession): string {
  return session.targetProfileUrl + GAG_PROFILE_CHAT_SEPARATOR +
    String(session.chatId);
}

/** 检查 URL 是否具有本模块签发的 Telegram 主页加超级群 ID fragment 形态。 */
export function isGagInlineMarkerUrl(url: string): boolean {
  const separatorIndex: number = url.lastIndexOf(GAG_PROFILE_CHAT_SEPARATOR);
  if (separatorIndex <= 0) return false;
  const rawChatId: string = url.slice(
    separatorIndex + GAG_PROFILE_CHAT_SEPARATOR.length
  );
  const chatId: number = Number(rawChatId);
  if (
    !CHAT_ID_ARG_PATTERN.test(rawChatId) ||
    !Number.isSafeInteger(chatId)
  ) return false;
  const profileUrl: string = url.slice(0, separatorIndex);
  if (profileUrl.startsWith(GAG_USER_PROFILE_LINK_PREFIX)) {
    const rawUserId: string = profileUrl.slice(
      GAG_USER_PROFILE_LINK_PREFIX.length
    );
    const userId: number = Number(rawUserId);
    return USER_ID_ARG_PATTERN.test(rawUserId) && Number.isSafeInteger(userId);
  }
  if (profileUrl.startsWith(GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX)) {
    const privateChannelScope: string = profileUrl.slice(
      GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX.length
    );
    const scopeSeparatorIndex: number = privateChannelScope.indexOf("/");
    if (scopeSeparatorIndex <= 0) return false;
    const rawChannelId: string = privateChannelScope.slice(
      0,
      scopeSeparatorIndex
    );
    const rawMessageId: string = privateChannelScope.slice(
      scopeSeparatorIndex + 1
    );
    const channelId: number = Number(rawChannelId);
    return USER_ID_ARG_PATTERN.test(rawChannelId) &&
      Number.isSafeInteger(channelId) &&
      rawMessageId === String(GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID);
  }
  if (!profileUrl.startsWith(GAG_PUBLIC_PROFILE_LINK_PREFIX)) return false;
  const username: string = profileUrl.slice(
    GAG_PUBLIC_PROFILE_LINK_PREFIX.length
  );
  if (!username.endsWith(GAG_PUBLIC_PROFILE_QUERY)) return false;
  return USERNAME_ARG_PATTERN.test(
    username.slice(0, -GAG_PUBLIC_PROFILE_QUERY.length)
  );
}
