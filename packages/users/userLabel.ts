import type { CachedUser } from "../types/chatState";
import { joinPersonName, sanitizeDisplayName } from "../libs/text";

/**
 * 生成用于回复文本中的、人类可读的用户/频道标签。当目标没有公开 @username 时
 * （例如是通过回复其消息而非 username 缓存解析出来的）退化为使用
 * first_name/title。
 * @param user 要生成标签的用户/频道。
 */
export function formatUserLabel(user: CachedUser): string {
  if (user.username) return `@${user.username}`;
  // title / first_name 是用户可控内容，同样要清洗后才拼进机器人的句子；
  // username 由 Telegram 限定字符集，直接用。
  if (user.isChannel) return sanitizeDisplayName(user.title ?? "") || "这个频道";
  return sanitizeDisplayName(user.first_name ?? "") || "这个杂鱼";
}

/**
 * 接受裸 id 的管理命令回执里的目标标签。
 *
 * 与 formatUserLabel 只差兜底那一档：什么身份字段都没有时退化成「用户 <id>」
 * 而不是泛指的「这个杂鱼」。按裸 id 下的命令正是这一档——那个人可能从没在
 * 本天才见过的群里说过话，缓存里自然什么都没有。回执必须把 id 原样念出来，
 * 否则打错一位数字，管理员从「已经把这个杂鱼踢出去了」里根本看不出来。
 * 频道身份念成「频道 <id>」：`/gag`、`/ungag`、`/unblock`、`/permission` 与
 * `/white` 都接受负数 id，管理员该从回执里看出本天才把它当成了哪一类目标；
 * `/unblock` 还据此决定走哪个解封接口。
 * @param user 目标用户/频道；只带 id 的最小身份也接受。
 */
export function formatTargetLabel(user: CachedUser): string {
  if (user.username !== undefined || user.first_name !== undefined || user.title !== undefined) {
    return formatUserLabel(user);
  }
  return user.isChannel === true ? `频道 ${user.id}` : `用户 ${user.id}`;
}

/**
 * 「first_name last_name」形式的展示名，供中文动作命令这类需要念出人名
 * 的场景使用（见 commands/cjkAction.ts）；`@username` 只在完全没有姓名时兜底。
 * 频道/匿名管理员没有姓名，退化为 title。昵称里的换行与连续空白会被压成
 * 单个空格，避免一句话被撑成多行。
 * @param user 要生成展示名的用户/频道。
 */
export function formatFullName(user: CachedUser): string {
  const rawName: string = user.isChannel
    ? user.title ?? ""
    : joinPersonName(user.first_name, user.last_name);
  const displayName: string = sanitizeDisplayName(rawName);
  if (displayName.length > 0) return displayName;
  return user.username ? `@${user.username}` : "这个杂鱼";
}

/**
 * 展示名要挂的个人主页链接。只有公开 username 能拼出稳定的 t.me 地址；
 * username 已由 Telegram 限定为字母数字下划线，直接拼接不会产生注入。
 * @returns 没有公开 username 时为 undefined（调用方应退化为纯文本）。
 */
export function formatProfileUrl(user: CachedUser): string | undefined {
  return user.username ? `https://t.me/${user.username}` : undefined;
}
