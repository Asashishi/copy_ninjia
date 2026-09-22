import type { WhitelistPermissionKey } from "../../../types/identityPolicy";
import type {
  PermissionCommandTexts,
  PermissionSetReplyParams,
  WhiteCommandTexts,
} from "../../../types/whitelist";

/** /permission help 展示的逐项权限说明。 */
export const WHITELIST_PERMISSION_HELP: Readonly<
  Record<WhitelistPermissionKey, string>
> = {
  isCanMute: "让这号杂鱼也能用 /mute 临时捂住普通成员的嘴，别乱给哦♡",
  isCanUnMute: "让这号杂鱼也能用 /unmute 提前松开普通成员的嘴，勉强算有点用♡",
  isCanGag: "让这号杂鱼能用 /gag 与 /ungag 控制群内用户或频道身份只能 @ 本天才说话，别乱戴东西哦♡",
  isCanViewBotStatus: "让这号杂鱼能用 /bot_status 查看全局模型能力、Telegram 出站和本群功能状态♡",
  isCanBlock: "让这号杂鱼能用 /block enable 把目标记进永久黑名单，还会在托管群里一起封掉哦♡",
  isCanUnBlock: "让这号杂鱼能用 /block disable 把目标移出永久黑名单，并解除所有托管群里的封禁哦♡",
  isCanWhiteOther: "让这号杂鱼能用 /white 给其它身份添加一套默认白名单权限；不能删除成员，也不能借此授予更多权限♡",
  isCanSwitchMood: "让这号杂鱼能用 /mood switch 重新抽取本天才现在的心情，可别把本天才折腾坏了♡",
  isCanBypassAdDetection: "让这个身份绕过广告检测与自动处置，本天才会当作没看见，别放广告杂鱼进来哦♡",
  isCanBypassFloodControl: "让这个身份绕过防刷屏计数与自动禁言，本天才不会按住 TA，别给刷屏杂鱼哦♡",
  isCanControllAIPermission: "让这号杂鱼能用 /ai_chat enable|disable 开关 AI 闲聊，别乱按呀♡",
  isCanConfigAiPrompt: "让这号杂鱼能用 /prompt config 和 /prompt remove 配置本群 AI 人设，可别把本天才改得面目全非哦♡",
  isCanClearContext: "允许使用 /clear_context 清空当前群的 AI 对话记忆，保留自定义人设。",
  isCanControllAdDetectPermission: "让这号杂鱼能用 /ad_detect enable|disable 开关广告检测，抓漏了就怪你哦♡",
  isCanControllFloodControlPermission: "让这号杂鱼能用 /flood_control enable|disable 开关防刷屏禁言，别乱按呀♡",
  isCanControllTranslatePermission: "让这号杂鱼能用 /translate enable|disable 开关翻译功能，这点小事总看得懂吧♡",
  isCanControllAntiRaidPermission: "让这号杂鱼能用 /antiraid enable|disable 开关入群验证与防冲群私密模式，关掉可就没人拦僵尸了哦♡",
  isCanControllQaPermission: "让这号杂鱼能用 /qa set 与 /qa remove 维护本群问答，答错了可别赖本天才♡",
  isCanAddHImage: "让这号杂鱼能用 /h_image add 把回复消息里的图收进本天才的随机图库，别塞奇怪的东西进来哦♡",
};

/** /permission help 的稳定 JSON 代码块。 */
export const WHITELIST_PERMISSION_HELP_JSON: string =
  JSON.stringify(WHITELIST_PERMISSION_HELP, null, 2);

/** /permission 用法说明的正文。 */
const PERMISSION_USAGE_TEXT: string =
  `哈？连这种命令都要本天才手把手教吗，杂鱼♡ ` +
  `设置权限用 /permission <用户id|频道id|@username> <权限键> <true|false>；` +
  `回复白名单身份时可以省略目标，只写 /permission <权限键> <true|false>；` +
  `想把全部权限打开就用 /permission <用户id|频道id|@username> all，回复目标时只写 /permission all；` +
  `查询自己用 /permission query，查询别人用 /permission query <用户id|@username>，或回复 TA 的消息发送 /permission query；` +
  `连权限说明都记不住就用 /permission help，笨蛋♡`;

/** /permission 的对外文案表。 */
export const PERMISSION_COMMAND_TEXTS: Readonly<PermissionCommandTexts> = {
  usage: PERMISSION_USAGE_TEXT,
  usageWithKeys: (keys: string): string =>
    `${PERMISSION_USAGE_TEXT}\n可用权限键：${keys}`,
  helpPrefix:
    "哼，连权限名都记不住，还得本天才整理给你看吗？睁大眼睛看好啦：true 是赏给你的，false 就是没你的份，杂鱼♡\n",
  helpSuffix: [
    "",
    "查询自己的权限：",
    "/permission query",
    "查询指定用户：/permission query <用户id|@username>",
    "也可以回复目标消息发送：/permission query",
    "",
    "help 和 query 所有杂鱼都能用；以下修改操作仅限超级管理员，杂鱼看懂就好，别伸手乱碰哦♡",
    "给已有白名单身份设置权限：",
    "/permission <用户id|频道id|@username> <权限键> <true|false>",
    "回复目标时可省略身份：/permission <权限键> <true|false>",
    "",
    "懒得一项项开，就把已有白名单身份的全部权限设为 true：",
    "/permission <用户id|频道id|@username> all",
    "回复目标时可省略身份：/permission all",
  ].join("\n"),
  queryPrefix: (targetLabel: string): string =>
    `哼，本天才勉为其难把 ${targetLabel} 的白名单权限列出来：true 是有这项权限，false 就是没有，睁大眼睛看好啦，杂鱼♡\n`,
  mutationRejection: (actorLabel: string): string =>
    `help 和 query 所有杂鱼都能用；不过就 ${actorLabel} 也想改本天才的权限配置？只有超级管理员才有资格呀，笨蛋♡`,
  superAdminTarget:
    `哈？超级管理员的权限可是本天才亲自认的身份带来的，本来就全开着，才不归白名单那点逐项授权管呢，笨蛋♡`,
  currentChatTarget:
    `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；` +
    `给它发权限等于把本天才交给随便哪个匿名管理员，本天才才不干♡`,
  targetNotWhitelisted: (targetLabel: string): string =>
    `${targetLabel} 还不在白名单里；先用 /white 把 TA 加进去再改权限呀，笨蛋♡`,
  mutationFailed:
    `啧，本天才没能把这条权限写进硬盘——杂鱼管理员快去看看 database/ 的写权限和磁盘♡`,
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
    missingTarget: `笨蛋，要回复一个白名单身份，或者把 @username、用户 id、频道 id 写在 /permission 后面呀，本天才可不会替你猜目标♡`,
    invalidUsername: (rawArgument: string): string =>
      `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户/频道 id♡`,
    unknownUsername: (rawUsername: string): string =>
      `笨蛋，@${rawUsername} 还没被本天才记住；先让 TA 冒个泡，或者回复 TA 的消息、直接给 id 吧♡`,
    conflictingTarget: (rawArgument: string): string =>
      `笨蛋，你回复了一个身份、又写了 ${rawArgument}，本天才不会猜到底指谁♡`,
    selfTarget: `笨蛋，本天才自己的权限不归白名单表管呀♡`,
  },
};

/** /white 的对外文案表。 */
export const WHITE_COMMAND_TEXTS: Readonly<WhiteCommandTexts> = {
  usage:
    `笨蛋，用法是 /white <用户id|频道id|@username> <enable|disable>；` +
    `回复目标消息时只写 /white <enable|disable> 就行啦♡`,
  rejection: (actorLabel: string): string =>
    `就 ${actorLabel} 也想改本天才的白名单？哪来的资格呀，笨蛋♡`,
  delegatedDisableRejection:
    `笨蛋，isCanWhiteOther 只准给其它身份添加默认权限白名单，删除成员还是只有超级管理员能做♡`,
  superAdminEnable:
    `笨蛋，超级管理员是本天才亲自认的身份，权限本来就全开着，才不用塞进白名单表里呀♡`,
  superAdminDisableCleared:
    `哼，白名单表里那条超级管理员的残留条目已经被本天才清掉啦——不过别搞错咯，` +
    `超级管理员本来就在本天才的白名单边界里、权限恒为全开，那可不是这条命令改得掉的♡`,
  superAdminDisableNoEntry:
    `笨蛋，白名单表里本来就没有超级管理员的残留条目；再说超级管理员的白名单身份是本天才亲自认的，` +
    `本来就不归这张表管呀♡`,
  currentChatTarget:
    `笨蛋，这是本群自己的身份呀——匿名管理员拿它当皮套时，Telegram 也不会告诉本天才皮套底下是谁；` +
    `把整个群加进白名单等于把本天才交给随便哪个匿名管理员，本天才才不干♡`,
  blocked: (targetLabel: string): string =>
    `笨蛋，${targetLabel} 还在黑名单里；先用 /block disable 解除，再加入白名单呀♡`,
  mutationFailed:
    `啧，本天才没能把白名单写进硬盘——杂鱼管理员快去看看 database/ 的写权限和磁盘♡`,
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
