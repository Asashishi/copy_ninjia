import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/identityPolicy";

/** 白名单条目缺省不可使用手动禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_MUTE: boolean = false;
/** 白名单条目缺省不可使用手动解除禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_UNMUTE: boolean = false;
/** 白名单条目缺省不可使用 /gag 与 /ungag。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_GAG: boolean = false;
/** 白名单条目缺省可以查看 /bot_status。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_VIEW_BOT_STATUS: boolean = true;
/** 白名单条目缺省不可写入永久黑名单。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BLOCK: boolean = false;
/** 白名单条目缺省不可移出永久黑名单。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_UNBLOCK: boolean = false;
/** 白名单条目缺省不可代为新增其它白名单身份。所属模块：packages/commands/white.ts。 */
const DEFAULT_IS_CAN_WHITE_OTHER: boolean = false;
/** 白名单条目缺省不可重抽 AI 心情。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_SWITCH_MOOD: boolean = false;
/** 白名单条目缺省绕过广告检测。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_AD_DETECTION: boolean = true;
/** 白名单条目缺省绕过防刷屏禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL: boolean = true;
/** 白名单条目缺省不可开关 AI 闲聊。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关广告检测。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关防刷屏禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关翻译功能。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_TRANSLATE_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关入群守卫。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_ANTI_RAID_PERMISSION: boolean = false;
/** 白名单条目缺省不可维护本群问答。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_QA_PERMISSION: boolean = false;
/** 白名单条目缺省不可往随机图库收图（`/h_image add`）。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_ADD_H_IMAGE: boolean = false;

/**
 * 白名单权限的完整默认值。跨调用方共享同一个对象，由 `Readonly<>` 在编译期
 * 锁住全部字段（不可变性只在编译期表达，见 AGENTS.md 的「常量」一节；断言在
 * `test/consts/immutability.test.ts`）。新增白名单成员使用这份完整默认值；
 * 已持久化权限必须逐项完整，不在读取时补齐。
 */
export const DEFAULT_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: DEFAULT_IS_CAN_MUTE,
  isCanUnMute: DEFAULT_IS_CAN_UNMUTE,
  isCanGag: DEFAULT_IS_CAN_GAG,
  isCanViewBotStatus: DEFAULT_IS_CAN_VIEW_BOT_STATUS,
  isCanBlock: DEFAULT_IS_CAN_BLOCK,
  isCanUnBlock: DEFAULT_IS_CAN_UNBLOCK,
  isCanWhiteOther: DEFAULT_IS_CAN_WHITE_OTHER,
  isCanSwitchMood: DEFAULT_IS_CAN_SWITCH_MOOD,
  isCanBypassAdDetection: DEFAULT_IS_CAN_BYPASS_AD_DETECTION,
  isCanBypassFloodControl: DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL,
  isCanControllAIPermission: DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION,
  isCanConfigAiPrompt: false,
  isCanClearContext: false,
  isCanControllAdDetectPermission: DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION,
  isCanControllFloodControlPermission: DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION,
  isCanControllTranslatePermission: DEFAULT_IS_CAN_CONTROLL_TRANSLATE_PERMISSION,
  isCanControllAntiRaidPermission: DEFAULT_IS_CAN_CONTROLL_ANTI_RAID_PERMISSION,
  isCanControllQaPermission: DEFAULT_IS_CAN_CONTROLL_QA_PERMISSION,
  isCanAddHImage: DEFAULT_IS_CAN_ADD_H_IMAGE,
};

/**
 * 非白名单身份的只读权限视图：逐项均为 false。
 *
 * `/permission query` 在同步白名单缓存没有目标条目时直接复用本对象，不创建、
 * 补齐或写入 SQLite 记录。字段顺序与 DEFAULT_WHITELIST_PERMISSIONS 保持一致，
 * 让三种查询视图拥有相同对象 shape。所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const NON_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: false,
  isCanUnMute: false,
  isCanGag: false,
  isCanViewBotStatus: false,
  isCanBlock: false,
  isCanUnBlock: false,
  isCanWhiteOther: false,
  isCanSwitchMood: false,
  isCanBypassAdDetection: false,
  isCanBypassFloodControl: false,
  isCanControllAIPermission: false,
  isCanConfigAiPrompt: false,
  isCanClearContext: false,
  isCanControllAdDetectPermission: false,
  isCanControllFloodControlPermission: false,
  isCanControllTranslatePermission: false,
  isCanControllAntiRaidPermission: false,
  isCanControllQaPermission: false,
  isCanAddHImage: false,
};

/**
 * 临时广告免检的固定权限：仅绕过广告检测，其余权限逐项为 false。
 *
 * 连续七个合格日只授予本视图，不创建永久白名单条目，也不提供防刷屏、命令、
 * 状态查看或入群验证权限。字段顺序必须与 DEFAULT_WHITELIST_PERMISSIONS 一致，
 * 让消息热路径的逐项权限读取保持稳定对象 shape。所属模块：
 * packages/infra/identityPolicy/whitelist.ts。
 */
export const TEMPORARY_AD_BYPASS_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: false,
  isCanUnMute: false,
  isCanGag: false,
  isCanViewBotStatus: false,
  isCanBlock: false,
  isCanUnBlock: false,
  isCanWhiteOther: false,
  isCanSwitchMood: false,
  isCanBypassAdDetection: true,
  isCanBypassFloodControl: false,
  isCanControllAIPermission: false,
  isCanConfigAiPrompt: false,
  isCanClearContext: false,
  isCanControllAdDetectPermission: false,
  isCanControllFloodControlPermission: false,
  isCanControllTranslatePermission: false,
  isCanControllAntiRaidPermission: false,
  isCanControllQaPermission: false,
  isCanAddHImage: false,
};

/**
 * 超级管理员的固定有效权限：逐项全开。
 *
 * 超级管理员的授权来自 `SUPER_ADMIN_USER_ID` 这个身份本身，不来自 SQLite
 * 白名单表——因此它**不写入**该表，只在运行时由
 * `packages/infra/identityPolicy/whitelist.ts` 的读取边界覆盖上去。这样既让所有可授予的
 * 白名单权限判定对超级管理员恒为 true（调用方不必再单独判身份），又保证
 * `/white`、`/permission` 永远只落盘管理员明确登记的条目：否则一旦
 * `SUPER_ADMIN_USER_ID` 换人，表里会留下一条全开的旧身份。
 *
 * 与 DEFAULT_WHITELIST_PERMISSIONS 一样跨调用方共享同一个对象，由
 * `Readonly<>` 在编译期锁住全部字段（断言在 `test/consts/immutability.test.ts`）。
 *
 * **字段顺序必须与 DEFAULT_WHITELIST_PERMISSIONS 逐字一致**：白名单权限读取边界
 * 在每条群消息的广告检测与防刷屏门禁上被调用（antiRaid/adCandidate.ts、
 * antiRaid/floodControl.ts），那里的权限字段取值只有在本对象与
 * `parseStoredPermissions`（database/codec/identity.ts）产出的条目共用同一个 JSC Structure
 * 时才保持单态。JSC 按
 * **键的插入顺序**分配 Structure，因此重排字段（哪怕键集合不变）会当场把这个
 * 热点取值打成多态。所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const SUPER_ADMIN_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: true,
  isCanUnMute: true,
  isCanGag: true,
  isCanViewBotStatus: true,
  isCanBlock: true,
  isCanUnBlock: true,
  isCanWhiteOther: true,
  isCanSwitchMood: true,
  isCanBypassAdDetection: true,
  isCanBypassFloodControl: true,
  isCanControllAIPermission: true,
  isCanConfigAiPrompt: true,
  isCanClearContext: true,
  isCanControllAdDetectPermission: true,
  isCanControllFloodControlPermission: true,
  isCanControllTranslatePermission: true,
  isCanControllAntiRaidPermission: true,
  isCanControllQaPermission: true,
  isCanAddHImage: true,
};

/** 白名单权限策略与 /permission 共同接受的权限键全集。 */
export const WHITELIST_PERMISSION_KEYS: readonly WhitelistPermissionKey[] = [
  "isCanMute",
  "isCanUnMute",
  "isCanGag",
  "isCanViewBotStatus",
  "isCanBlock",
  "isCanUnBlock",
  "isCanWhiteOther",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanBypassFloodControl",
  "isCanControllAIPermission",
  "isCanConfigAiPrompt",
  "isCanClearContext",
  "isCanControllAdDetectPermission",
  "isCanControllFloodControlPermission",
  "isCanControllTranslatePermission",
  "isCanControllAntiRaidPermission",
  "isCanControllQaPermission",
  "isCanAddHImage",
];

/**
 * 权限键的小写输入到规范拼写的只读索引；命令解析复用，避免每次从头遍历并对
 * 全部候选重复 lower-case。所属模块：packages/commands/permission.ts。
 */
export const WHITELIST_PERMISSION_KEY_BY_LOWERCASE: ReadonlyMap<
  string,
  WhitelistPermissionKey
> = new Map(
  WHITELIST_PERMISSION_KEYS.map(
    (key: WhitelistPermissionKey): readonly [string, WhitelistPermissionKey] =>
      [key.toLowerCase(), key]
  )
);
if (WHITELIST_PERMISSION_KEY_BY_LOWERCASE.size !== WHITELIST_PERMISSION_KEYS.length) {
  throw new Error("WHITELIST_PERMISSION_KEYS must be unique after lower-case normalization");
}

/** /permission 的权限说明子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_HELP_COMMAND: string = "help";
/** /permission 查询自身或指定用户权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_QUERY_COMMAND: string = "query";
/** /permission 全开已有身份权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_ALL_COMMAND: string = "all";
