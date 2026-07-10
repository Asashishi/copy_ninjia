import type { CachedUser } from "./types";

/**
 * 生成用于回复文本中的、人类可读的用户/频道标签。当目标没有公开 @username 时
 * （例如是通过回复其消息而非 username 缓存解析出来的）退化为使用
 * first_name/title。
 * @param user 要生成标签的用户/频道。
 */
export function formatUserLabel(user: CachedUser): string {
  if (user.username) return `@${user.username}`;
  if (user.isChannel) return user.title ?? "这个频道";
  return user.first_name ?? "这个杂鱼";
}
