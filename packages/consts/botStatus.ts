import type { BotChatPermissions } from "../types/telegram";

/** `/bot_status` 本机进程指标的换算与展示常量。 */

/** 一秒包含的微秒数；用于把 process.cpuUsage 与 uptime 放到同一量纲。 */
export const BOT_STATUS_MICROSECONDS_PER_SECOND: number = 1_000_000;

/** 百分比换算倍率；CPU 与内存占比统一使用。 */
export const BOT_STATUS_PERCENT_SCALE: number = 100;

/** `/bot_status` 百分比和容量统一保留的小数位数。 */
export const BOT_STATUS_DECIMAL_PLACES: number = 2;

/** 一分钟包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_MINUTE: number = 60;

/** 一小时包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_HOUR: number = 60 * BOT_STATUS_SECONDS_PER_MINUTE;

/** 一天包含的秒数；用于格式化 Bot 运行时长。 */
export const BOT_STATUS_SECONDS_PER_DAY: number = 24 * BOT_STATUS_SECONDS_PER_HOUR;

/** 一个 KiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_KIB: number = 1_024;

/** 一个 MiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_MIB: number =
  BOT_STATUS_BYTES_PER_KIB * BOT_STATUS_BYTES_PER_KIB;

/** 一个 GiB 包含的字节数；本机内存按二进制容量展示。 */
export const BOT_STATUS_BYTES_PER_GIB: number =
  BOT_STATUS_BYTES_PER_MIB * BOT_STATUS_BYTES_PER_KIB;

/**
 * 权限位的中文名。`/bot_status` 的权限块只列**已经拥有**的位：键沿用 Bot API 的
 * 英文字段名，值给这一位的中文名，读的人不必对着字段名猜含义；没有的位直接不出现，
 * 因此不需要「否」这种取值。
 *
 * 字段全集与展示顺序仍以 consts/botAdmin.ts 的 BOT_CHAT_PERMISSION_KEYS 为准，
 * 这里只补名字；新增权限位时两处都要加，缺了会在类型层报错。
 */
export const BOT_STATUS_PERMISSION_LABELS: Readonly<
  Record<keyof BotChatPermissions, string>
> = {
  isAdministrator: "管理员身份",
  isAnonymous: "匿名身份",
  canManageChat: "管理聊天",
  canDeleteMessages: "删除消息",
  canManageVideoChats: "管理视频聊天",
  canRestrictMembers: "限制与封禁成员",
  canPromoteMembers: "任免管理员",
  canChangeInfo: "修改聊天资料",
  canInviteUsers: "邀请用户",
  canManageTags: "管理成员标签",
  canPostStories: "发布故事",
  canEditStories: "编辑故事",
  canDeleteStories: "删除故事",
  canPostMessages: "频道发布消息",
  canEditMessages: "编辑频道消息",
  canPinMessages: "置顶消息",
  canManageTopics: "管理论坛话题",
  canManageDirectMessages: "管理频道私信",
};

/** 权限块的 JSON 缩进空格数；两格让 Telegram 代码块里逐行可读。 */
export const BOT_STATUS_PERMISSION_JSON_INDENT: number = 2;
/** 权限块 `pre` 实体的语言标签，让客户端按 JSON 高亮。 */
export const BOT_STATUS_PERMISSION_JSON_LANGUAGE: string = "json";
