import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/whitelist";

/** 白名单条目缺省不可使用手动禁言。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_MUTE: boolean = false;
/** 白名单条目缺省不可使用手动解除禁言。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_UNMUTE: boolean = false;
/** 白名单条目缺省不可写入永久黑名单。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_BLOCK: boolean = false;
/** 白名单条目缺省不可移出永久黑名单。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_UNBLOCK: boolean = false;
/** 白名单条目缺省不可跨群解除 Telegram 封禁。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_UNBLOCK_ALL: boolean = false;
/** 白名单条目缺省不可重抽 AI 心情。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_SWITCH_MOOD: boolean = false;
/** 白名单条目缺省绕过广告检测。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_AD_DETECTION: boolean = true;
/** 白名单条目缺省不可开关 AI 闲聊。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关广告检测。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关日语翻译。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_JA_TRANSLATE_PERMISSION: boolean = false;

/**
 * 白名单权限的完整默认值。跨调用方共享且冻结；配置文件允许只写需要覆盖的键，
 * 解析时统一从这里补齐。
 */
export const DEFAULT_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = Object.freeze({
  isCanMute: DEFAULT_IS_CAN_MUTE,
  isCanUnMute: DEFAULT_IS_CAN_UNMUTE,
  isCanBlock: DEFAULT_IS_CAN_BLOCK,
  isCanUnBlock: DEFAULT_IS_CAN_UNBLOCK,
  isCanUnBlockAll: DEFAULT_IS_CAN_UNBLOCK_ALL,
  isCanSwitchMood: DEFAULT_IS_CAN_SWITCH_MOOD,
  isCanBypassAdDetection: DEFAULT_IS_CAN_BYPASS_AD_DETECTION,
  isCanControllAIPermission: DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION,
  isCanControllAdDetectPermission: DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION,
  isCanControllJATranslatePermission: DEFAULT_IS_CAN_CONTROLL_JA_TRANSLATE_PERMISSION,
});

/** 白名单配置与 /permission 共同接受的权限键全集。 */
export const WHITELIST_PERMISSION_KEYS: readonly WhitelistPermissionKey[] = Object.freeze([
  "isCanMute",
  "isCanUnMute",
  "isCanBlock",
  "isCanUnBlock",
  "isCanUnBlockAll",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanControllAIPermission",
  "isCanControllAdDetectPermission",
  "isCanControllJATranslatePermission",
]);

/** /permission 的权限说明子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_HELP_COMMAND: string = "help";
/** /permission 全开已有身份权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_ALL_COMMAND: string = "all";

/**
 * /permission help 展示的逐项权限说明。键集合必须与 WhitelistPermissions
 * 完全一致，并保持与各命令实际权限边界相同的口径。
 */
export const WHITELIST_PERMISSION_HELP: Readonly<
  Record<WhitelistPermissionKey, string>
> = Object.freeze({
  isCanMute: "让这号杂鱼也能用 /mute 临时捂住普通成员的嘴，别乱给哦♡",
  isCanUnMute: "让这号杂鱼也能用 /unmute 提前松开普通成员的嘴，勉强算有点用♡",
  isCanBlock: "让这号杂鱼能用 /block 把目标记进永久黑名单，还会在托管群里一起封掉哦♡",
  isCanUnBlock: "让这号杂鱼能用 /unblock 把目标移出永久黑名单；默认可不会顺手解除各群封禁，笨蛋♡",
  isCanUnBlockAll: "让 /unblock 带上 all 跨群解除封禁；还得同时有 isCanUnBlock，别漏了呀♡",
  isCanSwitchMood: "让这号杂鱼能用 /switch_mood 重新抽取本天才现在的心情，可别把本天才折腾坏了♡",
  isCanBypassAdDetection: "让这个身份绕过广告检测与自动处置，本天才会当作没看见，别放广告杂鱼进来哦♡",
  isCanControllAIPermission: "让这号杂鱼能用 /ai_chat enable|disable 开关 AI 闲聊，别乱按呀♡",
  isCanControllAdDetectPermission: "让这号杂鱼能用 /ad_detect enable|disable 开关广告检测，抓漏了就怪你哦♡",
  isCanControllJATranslatePermission: "让这号杂鱼能用 /ja_copy enable|disable 开关日语翻译，这点小事总看得懂吧♡",
});
