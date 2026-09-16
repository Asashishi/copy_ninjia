import type { WhitelistPermissionKey } from "../../../types/identityPolicy";
import type { PermissionCommandTexts, PermissionSetReplyParams, WhiteCommandTexts } from "../../../types/whitelist";

/** 普通风格的权限说明。 */
export const WHITELIST_PERMISSION_HELP: Readonly<Record<WhitelistPermissionKey, string>> = {
  isCanMute: "允许使用 /mute 临时禁言普通成员。",
  isCanUnMute: "允许使用 /unmute 提前解除普通成员的禁言。",
  isCanGag: "允许使用 /gag 和 /ungag 管理用户或频道身份的文字发言限制。",
  isCanViewBotStatus: "允许使用 /bot_status 查看模型能力、Telegram 出站和本群状态。",
  isCanBlock: "允许使用 /block 将用户加入永久黑名单并在受管群封禁。",
  isCanUnBlock: "允许使用 /unblock 移除永久黑名单记录并解除受管群封禁。",
  isCanWhiteOther: "允许使用 /white 为其他身份添加默认白名单权限；不能删除身份或授予额外权限。",
  isCanSwitchMood: "允许使用 /mood switch 重新抽取本群 AI 心情。",
  isCanBypassAdDetection: "跳过此身份的广告检测和自动处置。",
  isCanBypassFloodControl: "跳过此身份的防刷屏计数和自动禁言。",
  isCanControllAIPermission: "允许使用 /ai_chat enable|disable 开关本群 AI 闲聊。",
  isCanConfigAiPrompt: "允许使用 /prompt config 和 /prompt remove 配置本群 AI 人设。",
  isCanClearContext: "允许使用 /clear_context 清空当前群的 AI 对话记忆，保留自定义人设。",
  isCanControllAdDetectPermission: "允许使用 /ad_detect enable|disable 开关广告检测。",
  isCanControllFloodControlPermission: "允许使用 /flood_control enable|disable 开关防刷屏禁言。",
  isCanControllTranslatePermission: "允许使用 /translate enable|disable 开关翻译功能。",
  isCanControllAntiRaidPermission: "允许使用 /antiraid enable|disable 开关入群验证和防冲群私密模式。",
  isCanControllQaPermission: "允许使用 /qa set 和 /qa remove 维护本群问答。",
};

/** 不可变说明表只在模块初始化时序列化一次。 */
export const WHITELIST_PERMISSION_HELP_JSON: string = JSON.stringify(WHITELIST_PERMISSION_HELP, null, 2);

/** 权限命令用法。 */
const PERMISSION_USAGE_TEXT: string =
  "设置权限：/permission <用户id|频道id|@username> <权限键> <true|false>；回复目标时可省略身份；" +
  "开启全部权限：/permission <用户id|频道id|@username> all，或回复目标发送 /permission all；" +
  "查询自己：/permission query；查询别人：/permission query <用户id|@username>，或回复目标发送 /permission query；" +
  "查看权限说明：/permission help。";

/** 普通风格的权限帮助、查询和修改回执。 */
export const PERMISSION_COMMAND_TEXTS: Readonly<PermissionCommandTexts> = {
  usage: PERMISSION_USAGE_TEXT,
  usageWithKeys: (keys: string): string => `${PERMISSION_USAGE_TEXT}\n可用权限键：${keys}`,
  helpPrefix: "权限说明：true 表示已授权，false 表示未授权。\n",
  helpSuffix: "\n查询自己：/permission query\n查询指定用户：/permission query <用户id|@username>\n" +
    "也可回复目标消息发送 /permission query\n\n" +
    "所有人均可使用 help 和 query；修改仅限超级管理员。\n" +
    "修改已有白名单身份：/permission <用户id|频道id|@username> <权限键> <true|false>\n" +
    "回复目标时可省略身份：/permission <权限键> <true|false>\n" +
    "开启全部权限：/permission <用户id|频道id|@username> all\n" +
    "回复目标时可省略身份：/permission all",
  queryPrefix: (targetLabel: string): string => `${targetLabel} 的权限：true 表示已授权，false 表示未授权。\n`,
  mutationRejection: (actorLabel: string): string => `${actorLabel} 可以使用 help 和 query 查看权限；修改权限仅限超级管理员。`,
  superAdminTarget: "超级管理员由身份授予全部权限，不受白名单逐项授权控制。",
  currentChatTarget: "不能为当前群身份授权：Telegram 无法提供其背后匿名管理员的个人身份。",
  targetNotWhitelisted: (targetLabel: string): string => `${targetLabel} 尚未加入白名单，请先使用 /white 添加。`,
  mutationFailed: "权限未能保存，请管理员检查数据库目录的写入权限和磁盘。",
  allEnabled: (targetLabel: string): string => `${targetLabel} 的全部权限已开启。`,
  allAlreadyEnabled: (targetLabel: string): string => `${targetLabel} 的权限原本就已全部开启。`,
  permissionSet: ({ targetLabel, key, value, changed }: PermissionSetReplyParams): string =>
    `${targetLabel} 的 ${key} ${changed ? "已设为" : "原本就是"} ${String(value)}。`,
  target: {
    missingTarget: "请回复白名单身份，或在 /permission 后指定 @username、用户 id 或频道 id。",
    invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
    unknownUsername: (username: string): string => `尚未记录 @${username}，请让目标先发言、回复目标消息或直接提供 id。`,
    conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
    selfTarget: "机器人自身的权限不受白名单表控制。",
  },
};

/** 普通风格的白名单回执。 */
export const WHITE_COMMAND_TEXTS: Readonly<WhiteCommandTexts> = {
  usage: "用法：/white <用户id|频道id|@username> <enable|disable>；回复目标时可省略身份。",
  rejection: (actorLabel: string): string => `${actorLabel} 没有管理白名单的权限。`,
  delegatedDisableRejection: "isCanWhiteOther 仅允许代加默认白名单权限，删除身份仅限超级管理员。",
  superAdminEnable: "超级管理员由身份授予全部权限，无需加入白名单表。",
  superAdminDisableCleared: "已清理白名单表中的超级管理员残留记录；其身份仍拥有全部权限。",
  superAdminDisableNoEntry: "白名单表中没有超级管理员的残留记录，其权限由身份授予。",
  currentChatTarget: "不能将当前群身份加入白名单：Telegram 无法提供其背后匿名管理员的个人身份。",
  blocked: (targetLabel: string): string => `${targetLabel} 仍在黑名单中，请先使用 /unblock 解除。`,
  mutationFailed: "白名单未能保存，请管理员检查数据库目录的写入权限和磁盘。",
  enabled: (targetLabel: string): string => `已将 ${targetLabel} 加入白名单并授予默认权限。`,
  alreadyEnabled: (targetLabel: string): string => `${targetLabel} 原本就在白名单中，已有权限保持不变。`,
  disabled: (targetLabel: string): string => `已将 ${targetLabel} 移出白名单。`,
  alreadyDisabled: (targetLabel: string): string => `${targetLabel} 原本就不在白名单中。`,
  target: {
    missingTarget: "请回复用户或频道消息，或在 /white 后指定 @username、用户 id 或频道 id。",
    invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
    unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息或直接提供 id。`,
    conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
    selfTarget: "无需将机器人自身加入白名单。",
  },
};
