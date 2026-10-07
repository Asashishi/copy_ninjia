import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import { joinPersonName, sanitizeDisplayName } from "../libs/text";

/**
 * 生成用于回复文本中的、人类可读的用户/频道标签。当目标没有公开 @username 时
 * （例如是通过回复其消息而非 username 缓存解析出来的）退化为使用
 * first_name/title。
 * @param user 要生成标签的用户/频道。
 */
export function formatUserLabel(user: CachedUser, atmosphere: AtmosphereTexts): string {
  if (user.username) return `@${user.username}`;
  // title / first_name 是用户可控内容，同样要清洗后才拼进机器人的句子；
  // username 由 Telegram 限定字符集，直接用。
  if (user.isChannel) return sanitizeDisplayName(user.title ?? "") || atmosphere.NOTICE_TEXTS.unknownChannel;
  return sanitizeDisplayName(user.first_name ?? "") || atmosphere.NOTICE_TEXTS.unknownUser;
}

/**
 * 命令回执里的发起人标签。解析不出发起人（匿名管理员、频道身份或缓存缺失）
 * 时退化为氛围文案里的「未知发起人」措辞，其余情况与 formatUserLabel 一致。
 * @param actor 已解析的发起人；未解析出来时传 undefined。
 * @param atmosphere 本进程的氛围文案。
 */
export function formatActorLabel(actor: CachedUser | undefined, atmosphere: AtmosphereTexts): string {
  return actor === undefined ? atmosphere.NOTICE_TEXTS.unknownActor : formatUserLabel(actor, atmosphere);
}

/**
 * 接受裸 id 的管理命令回执里的目标标签。
 *
 * 与 formatUserLabel 只差兜底那一档：没有任何身份字段时，按氛围文案的 userIdLabel /
 * channelIdLabel 写成带 id 的称呼，回执原样给出 id。按裸 id 下的命令缓存里可能没有该身份；
 * `/gag`、`/ungag`、`/block disable`、`/permission` 与 `/white` 都接受负数 id，
 * 回执据此体现目标类别，`/block disable` 还据此决定走哪个解封接口。
 * @param user 目标用户/频道；只带 id 的最小身份也接受。
 */
export function formatTargetLabel(user: CachedUser, atmosphere: AtmosphereTexts): string {
  if (user.username !== undefined || user.first_name !== undefined || user.title !== undefined) {
    return formatUserLabel(user, atmosphere);
  }
  return user.isChannel === true
    ? atmosphere.NOTICE_TEXTS.channelIdLabel(user.id)
    : atmosphere.NOTICE_TEXTS.userIdLabel(user.id);
}

/**
 * 「first_name last_name」形式的展示名，供中文动作命令这类需要念出人名
 * 的场景使用（见 commands/cjkAction.ts）；`@username` 只在完全没有姓名时兜底。
 * 频道/匿名管理员没有姓名，退化为 title。昵称里的换行与连续空白被压成
 * 单个空格。
 * @param user 要生成展示名的用户/频道。
 */
export function formatFullName(user: CachedUser, atmosphere: AtmosphereTexts): string {
  const rawName: string = user.isChannel
    ? user.title ?? ""
    : joinPersonName(user.first_name, user.last_name);
  const displayName: string = sanitizeDisplayName(rawName);
  if (displayName.length > 0) return displayName;
  return user.username ? `@${user.username}` : atmosphere.NOTICE_TEXTS.unknownUser;
}

/**
 * 展示名要挂的个人主页链接。只有公开 username 能拼出稳定的 t.me 地址；
 * username 字符集由 Telegram 限定为字母数字下划线，直接拼接。
 * @returns 没有公开 username 时为 undefined（调用方应退化为纯文本）。
 */
export function formatProfileUrl(user: CachedUser): string | undefined {
  return user.username ? `https://t.me/${user.username}` : undefined;
}
