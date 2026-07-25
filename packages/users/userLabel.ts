import type { CachedUser } from "../types/chatState";

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

/**
 * 权限校验失败时嘲讽文案里的发起人标签：ctx.from 可能缺失（极端更新形态），
 * 此时退化为泛指。/kick 与超管开关命令共用。
 * @param fromUser 发起命令的 ctx.from（可能为 undefined）。
 */
export function formatMockerLabel(fromUser: { id: number; username?: string; first_name?: string } | undefined): string {
  return fromUser
    ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
    : "哪个杂鱼";
}
