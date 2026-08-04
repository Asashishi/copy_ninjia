import type {
  PermissionCommandTexts,
  PermissionSetReplyParams,
  WhiteCommandTexts,
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
/** 白名单条目缺省不可重抽 AI 心情。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_SWITCH_MOOD: boolean = false;
/** 白名单条目缺省绕过广告检测。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_AD_DETECTION: boolean = true;
/** 白名单条目缺省绕过防刷屏禁言。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL: boolean = true;
/** 白名单条目缺省不可开关 AI 闲聊。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关广告检测。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关防刷屏禁言。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关日语翻译。所属模块：packages/config/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_JA_TRANSLATE_PERMISSION: boolean = false;

/**
 * 白名单权限的完整默认值。跨调用方共享同一个对象，由 `Readonly<>` 在编译期
 * 锁住全部字段（不可变性只在编译期表达，见 AGENTS.md 的「常量」一节；断言在
 * `test/consts/immutability.test.ts`）。配置文件允许只写需要覆盖的键，解析时
 * 统一从这里补齐。
 */
export const DEFAULT_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: DEFAULT_IS_CAN_MUTE,
  isCanUnMute: DEFAULT_IS_CAN_UNMUTE,
  isCanBlock: DEFAULT_IS_CAN_BLOCK,
  isCanUnBlock: DEFAULT_IS_CAN_UNBLOCK,
  isCanSwitchMood: DEFAULT_IS_CAN_SWITCH_MOOD,
  isCanBypassAdDetection: DEFAULT_IS_CAN_BYPASS_AD_DETECTION,
  isCanBypassFloodControl: DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL,
  isCanControllAIPermission: DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION,
  isCanControllAdDetectPermission: DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION,
  isCanControllFloodControlPermission: DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION,
  isCanControllJATranslatePermission: DEFAULT_IS_CAN_CONTROLL_JA_TRANSLATE_PERMISSION,
};

/**
 * 超级管理员的固定有效权限：逐项全开。
 *
 * 超级管理员的授权来自 `SUPER_ADMIN_USER_ID` 这个身份本身，不来自
 * config/whitelist.json —— 因此它**不写入**部署配置文件，只在运行时由
 * `packages/config/whitelist.ts` 的读取边界覆盖上去。这样既让所有可授予的
 * 白名单权限判定对超级管理员恒为 true（调用方不必再单独判身份），又保证
 * `/white`、`/permission` 的整份改写永远只落盘部署方自己配过的条目：
 * 否则一旦 `SUPER_ADMIN_USER_ID` 换人，文件里会留下一条全开的旧身份。
 *
 * 与 DEFAULT_WHITELIST_PERMISSIONS 一样跨调用方共享同一个对象，由
 * `Readonly<>` 在编译期锁住全部字段（断言在 `test/consts/immutability.test.ts`）。
 *
 * **字段顺序必须与 DEFAULT_WHITELIST_PERMISSIONS 逐字一致**：`hasWhitelistPermission`
 * 在每条群消息的广告检测与防刷屏门禁上被调用（antiRaid/adCandidate.ts、
 * antiRaid/floodControl.ts），那里的 `permissions[key]` 取值只有在本对象与
 * parsePermissions 产出的条目共用同一个 JSC Structure 时才保持单态。JSC 按
 * **键的插入顺序**分配 Structure，因此重排字段（哪怕键集合不变）会当场把这个
 * 热点取值打成多态。所属模块：packages/config/whitelist.ts。
 */
export const SUPER_ADMIN_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: true,
  isCanUnMute: true,
  isCanBlock: true,
  isCanUnBlock: true,
  isCanSwitchMood: true,
  isCanBypassAdDetection: true,
  isCanBypassFloodControl: true,
  isCanControllAIPermission: true,
  isCanControllAdDetectPermission: true,
  isCanControllFloodControlPermission: true,
  isCanControllJATranslatePermission: true,
};

/** 白名单配置与 /permission 共同接受的权限键全集。 */
export const WHITELIST_PERMISSION_KEYS: readonly WhitelistPermissionKey[] = [
  "isCanMute",
  "isCanUnMute",
  "isCanBlock",
  "isCanUnBlock",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanBypassFloodControl",
  "isCanControllAIPermission",
  "isCanControllAdDetectPermission",
  "isCanControllFloodControlPermission",
  "isCanControllJATranslatePermission",
];

/** /permission 的权限说明子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_HELP_COMMAND: string = "help";
/** /permission 查询发起身份自身权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_QUERY_COMMAND: string = "query";
/** /permission 全开已有身份权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_ALL_COMMAND: string = "all";

/**
 * /permission help 展示的逐项权限说明。键集合必须与 WhitelistPermissions
 * 完全一致，并保持与各命令实际权限边界相同的口径。
 */
export const WHITELIST_PERMISSION_HELP: Readonly<
  Record<WhitelistPermissionKey, string>
> = {
  isCanMute: "让这号杂鱼也能用 /mute 临时捂住普通成员的嘴，别乱给哦♡",
  isCanUnMute: "让这号杂鱼也能用 /unmute 提前松开普通成员的嘴，勉强算有点用♡",
  isCanBlock: "让这号杂鱼能用 /block 把目标记进永久黑名单，还会在托管群里一起封掉哦♡",
  isCanUnBlock: "让这号杂鱼能用 /unblock 把目标移出永久黑名单，并解除所有托管群里的封禁哦♡",
  isCanSwitchMood: "让这号杂鱼能用 /switch_mood 重新抽取本天才现在的心情，可别把本天才折腾坏了♡",
  isCanBypassAdDetection: "让这个身份绕过广告检测与自动处置，本天才会当作没看见，别放广告杂鱼进来哦♡",
  isCanBypassFloodControl: "让这个身份绕过防刷屏计数与自动禁言，本天才不会按住 TA，别给刷屏杂鱼哦♡",
  isCanControllAIPermission: "让这号杂鱼能用 /ai_chat enable|disable 开关 AI 闲聊，别乱按呀♡",
  isCanControllAdDetectPermission: "让这号杂鱼能用 /ad_detect enable|disable 开关广告检测，抓漏了就怪你哦♡",
  isCanControllFloodControlPermission: "让这号杂鱼能用 /flood_control enable|disable 开关防刷屏禁言，别乱按呀♡",
  isCanControllJATranslatePermission: "让这号杂鱼能用 /ja_copy enable|disable 开关日语翻译，这点小事总看得懂吧♡",
};

/** /permission 用法说明的正文；usage 与 usageWithKeys 共用同一份措辞。 */
const PERMISSION_USAGE_TEXT: string =
  `哈？连这种命令都要本天才手把手教吗，杂鱼♡ ` +
  `设置权限用 /permission <用户id|频道id|@username> <权限键> <true|false>；` +
  `回复白名单身份时可以省略目标，只写 /permission <权限键> <true|false>；` +
  `想把全部权限打开就用 /permission <用户id|频道id|@username> all，回复目标时只写 /permission all；` +
  `想偷看自己有几斤几两就用 /permission query，连权限说明都记不住就用 /permission help，笨蛋♡`;

/**
 * /permission 的对外文案表。字段口径与「前缀必须以换行结尾」这条不变量见
 * packages/types/whitelist.ts 的 PermissionCommandTexts；跨调用方共享同一个
 * 对象，由 `Readonly<>` 在编译期锁住全部字段（断言在
 * `test/consts/immutability.test.ts`）。所属模块：packages/commands/permission.ts。
 */
export const PERMISSION_COMMAND_TEXTS: Readonly<PermissionCommandTexts> = {
  usage: PERMISSION_USAGE_TEXT,
  usageWithKeys: (keys: string): string =>
    `${PERMISSION_USAGE_TEXT}\n可用权限键：${keys}`,
  helpPrefix:
    "哼，连权限名都记不住，还得本天才整理给你看吗？睁大眼睛看好啦：true 是赏给你的，false 就是没你的份，杂鱼♡\n",
  helpSuffix: [
    "",
    "想知道自己有几斤几两就发：",
    "/permission query",
    "",
    "以下修改操作仅限超级管理员，白名单杂鱼看懂就好，别伸手乱碰哦♡",
    "给已有白名单身份设置权限：",
    "/permission <用户id|频道id|@username> <权限键> <true|false>",
    "回复目标时可省略身份：/permission <权限键> <true|false>",
    "",
    "懒得一项项开，就把已有白名单身份的全部权限设为 true：",
    "/permission <用户id|频道id|@username> all",
    "回复目标时可省略身份：/permission all",
  ].join("\n"),
  queryPrefix:
    "哼，连自己有几斤几两都不知道吗？本天才勉为其难把你的白名单权限列出来：true 是赏给你的，false 就是你还不配，睁大眼睛看好啦，杂鱼♡\n",
  outsiderRejection: (actorLabel: string): string =>
    `哈？${actorLabel} 还不在里面，这种白名单门都没摸到的杂鱼也敢偷看本天才的权限说明？先拿到资格再来啦，笨蛋♡`,
  mutationRejection: (actorLabel: string): string =>
    `就 ${actorLabel} 也想改本天才的权限配置？哪来的资格呀，笨蛋♡`,
  superAdminTarget:
    `哈？超级管理员的权限可是本天才亲自认的身份带来的，本来就全开着，才不归白名单那点逐项授权管呢，笨蛋♡`,
  currentChatTarget:
    `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；` +
    `给它发权限等于把本天才交给随便哪个匿名管理员，本天才才不干♡`,
  targetNotWhitelisted: (targetLabel: string): string =>
    `${targetLabel} 还不在白名单里；先用 /white 把 TA 加进去再改权限呀，笨蛋♡`,
  mutationFailed:
    `啧，本天才没能把这条权限写进硬盘，配置一点没动——杂鱼管理员快去看看 config/ 的写权限和磁盘♡`,
  allEnabled: (targetLabel: string): string =>
    `哼，${targetLabel} 的权限已经被本天才全部打开啦，可别拿去乱来哦♡`,
  allAlreadyEnabled: (targetLabel: string): string =>
    `笨蛋，${targetLabel} 的权限本来就是全开的，还想让本天才开几次呀♡`,
  permissionSet: ({
    targetLabel,
    key,
    value,
    changed,
  }: PermissionSetReplyParams): string =>
    `哼，${targetLabel} 的 ${key} ${changed ? "已设为" : "原本就是"} ${String(value)} 啦♡`,
  target: {
    missingTarget: `笨蛋，要回复一个白名单身份，或者把用户/频道 id 写在 /permission 后面呀♡`,
    invalidUsername: (rawArgument: string): string =>
      `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户/频道 id♡`,
    unknownUsername: (rawUsername: string): string =>
      `笨蛋，@${rawUsername} 还没被本天才记住；回复 TA 的消息或直接给 id 吧♡`,
    conflictingTarget: (rawArgument: string): string =>
      `笨蛋，你回复了一个身份、又写了 ${rawArgument}，本天才不会猜要改谁的权限♡`,
    selfTarget: `笨蛋，本天才自己的权限不归白名单配置管呀♡`,
  },
};

/**
 * /white 的对外文案表。与 PERMISSION_COMMAND_TEXTS 同一份口径：成员关系的四种
 * 结局各有各的话，重复 enable/disable 必须说破「本来就是这样」。
 * 所属模块：packages/commands/white.ts。
 */
export const WHITE_COMMAND_TEXTS: Readonly<WhiteCommandTexts> = {
  usage:
    `笨蛋，用法是 /white <用户id|频道id|@username> <enable|disable>；` +
    `回复目标消息时只写 /white <enable|disable> 就行啦♡`,
  rejection: (actorLabel: string): string =>
    `就 ${actorLabel} 也想改本天才的白名单？哪来的资格呀，笨蛋♡`,
  superAdminEnable:
    `笨蛋，超级管理员是本天才亲自认的身份，权限本来就全开着，才不用塞进白名单文件里呀♡`,
  superAdminDisableCleared:
    `哼，文件里那条超级管理员的残留条目已经被本天才清掉啦——不过别搞错咯，` +
    `超级管理员本来就在本天才的白名单边界里、权限恒为全开，那可不是这条命令改得掉的♡`,
  superAdminDisableNoEntry:
    `笨蛋，文件里本来就没有超级管理员的残留条目；再说超级管理员的白名单身份是本天才亲自认的，` +
    `本来就不归这份文件管呀♡`,
  currentChatTarget:
    `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；` +
    `把整个群加进白名单等于把本天才交给随便哪个匿名管理员，本天才才不干♡`,
  blocked: (targetLabel: string): string =>
    `笨蛋，${targetLabel} 还在黑名单里；先用 /unblock 解除，再加入白名单呀♡`,
  mutationFailed:
    `啧，本天才没能把白名单写进硬盘，名单一点没动——杂鱼管理员快去看看 config/ 的写权限和磁盘♡`,
  enabled: (targetLabel: string): string =>
    `哼，${targetLabel} 已经被本天才加进白名单啦，先赏 TA 一套默认权限♡`,
  alreadyEnabled: (targetLabel: string): string =>
    `笨蛋，${targetLabel} 本来就在白名单里，已有权限当然不会被重置呀♡`,
  disabled: (targetLabel: string): string =>
    `哼，${targetLabel} 已经被本天才从白名单里踢出去啦♡`,
  alreadyDisabled: (targetLabel: string): string =>
    `笨蛋，${targetLabel} 本来就不在白名单里，还想删什么呀♡`,
  target: {
    missingTarget: `笨蛋，要回复一条用户或频道消息，或者把 @username、用户/频道 id 写在 /white 后面呀♡`,
    invalidUsername: (rawArgument: string): string =>
      `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户/频道 id♡`,
    unknownUsername: (rawUsername: string): string =>
      `笨蛋，@${rawUsername} 还没被本天才记住；回复 TA 的消息或直接给 id 吧♡`,
    conflictingTarget: (rawArgument: string): string =>
      `笨蛋，你回复了一个身份、又写了 ${rawArgument}，本天才才不替你猜要改谁♡`,
    selfTarget: `笨蛋，本天才自己才不用塞进白名单里呀♡`,
  },
};
