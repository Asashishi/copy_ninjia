import type { BotCommand } from "grammy/types";
import type { CommandTargetMessages, ToggleCommandTexts } from "../../../types/commands";

import { STATE_MANAGED_CHAT_LIMIT } from "../../storage";

/** Telegram 聊天框展示的命令菜单。 */
export const BOT_COMMANDS: readonly Readonly<BotCommand>[] = [
  { command: "copy", description: "复读目标；reverse 倒序 / nya 加喵~ / stop 停止；回复目标或加 @username" },
  { command: "translate", description: "ja 日语 / cn 简体中文 / en 美式英语 / uk 乌克兰语 / ru 俄语；回复目标或加 @username；list 查看，stop 停止，enable/disable 开关" },
  { command: "icon", description: "steal 使用目标头像，回复目标或加 @username；reset 恢复默认头像" },
  { command: "wed", description: "随机抽取群友老婆；可确认、更换和移除，再发 /wed 可重新抽取" },
  { command: "h_image", description: "从随机图片目录抽一张图发到本群；回复带图片的消息发送 add 可把图片收进图库，需要 isCanAddHImage" },
  { command: "x", description: "将 x 换成任意 1~2 个中文字，如 /咬、/贴贴；回复目标或加 @username" },
  { command: "block", description: "末尾 enable 加入永久黑名单并在所有受管群封禁（需要 isCanBlock），disable 移出并解除封禁（需要 isCanUnBlock）；回复目标、@username 或用户 id，disable 另认频道 id" },
  { command: "prompt", description: "config/remove 配置或移除本群 AI 自定义提示词；需要 isCanConfigAiPrompt" },
  { command: "ai_chat", description: "enable/disable 开关本群 AI 闲聊；需要 AI 管理权限" },
  { command: "clear_context", description: "清空本群内存和数据库中的 AI 上下文；不带参数，需要 isCanClearContext" },
  { command: "ad_detect", description: "enable/disable 开关本群广告检测；命中后拉黑、跨群封禁并删除消息；需要广告检测管理权限" },
  { command: "flood_control", description: "enable/disable 开关本群防刷屏禁言；需要防刷屏管理权限" },
  { command: "antiraid", description: "enable/disable 开关本群入群验证和防冲群私密模式；需要防冲群管理权限" },
  { command: "bot_status", description: "查看进程、模型能力、Telegram 出站、本群权限、提示词配置和功能状态" },
  { command: "mood", description: "query 查看本群 AI 当前心情；switch 重新抽取，需要心情切换权限" },
  { command: "init", description: "enable/disable 开关本群机器人监听；仅超级管理员可用" },
  { command: "quiet", description: "暂停机器人自动回复 1~15 分钟，默认 3 分钟" },
  { command: "unquiet", description: "提前解除 /quiet，恢复自动回复" },
  { command: "mute", description: "临时禁言目标，时长必填，如 10m/2h/1d（1 分钟~365 天）；回复目标、@username 或用户 id；需要 isCanMute" },
  { command: "unmute", description: "提前解除目标禁言；回复目标、@username 或用户 id；需要 isCanUnMute" },
  { command: "gag", description: "限制用户或频道的文字发言 5/10/15 分钟，默认 5 分钟；回复目标、@username 或身份 id；需要 isCanGag" },
  { command: "ungag", description: "解除目标 gag；回复目标、@username 或用户/频道 id；需要 isCanGag" },
  { command: "batch_kick", description: "踢出本群滚动时间窗内加入的成员，如 30m/2h/1d；不加入黑名单，仅超级管理员可用" },
  { command: "permission", description: "help 查看说明，query 查询权限；所有人可查看，修改仅限超级管理员" },
  { command: "qa", description: "set 登记问答，remove <问题> 删除，均需问答管理权限；query [问题] 查询一条或全部，群成员可查看" },
  { command: "white", description: "新增或删除白名单身份；isCanWhiteOther 可代加默认权限，删除仅限超级管理员" },
];

/** 黑白名单冷读失败、本次命令放弃执行时的提示。 */
export const IDENTITY_POLICY_UNAVAILABLE_TEXT: string = "暂时无法读取黑白名单，本次未执行任何处置，请稍后重试。";

/** 权限看板读取失败时的临时提示。 */
export const IDENTITY_POLICY_QUERY_UNAVAILABLE_TEXT: string = "暂时无法读取权限，请稍后查询。";

/** `/ai_chat enable|disable` 的全部文案。 */
export const AI_CHAT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群AI 闲聊的权限。`,
  usage: "用 /ai_chat enable 开启，或 /ai_chat disable 关闭。",
  enabled: "本群AI 闲聊已开启。",
  disabled: "本群AI 闲聊已关闭。",
  alreadyEnabled: "本群AI 闲聊已经处于开启状态。",
  alreadyDisabled: "本群AI 闲聊已经处于关闭状态。",
};

/** `/ad_detect enable|disable` 的全部文案。 */
export const AD_DETECT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群广告检测的权限。`,
  usage: "用 /ad_detect enable 开启，或 /ad_detect disable 关闭。",
  enabled: "本群广告检测已开启。",
  disabled: "本群广告检测已关闭。",
  alreadyEnabled: "本群广告检测已经处于开启状态。",
  alreadyDisabled: "本群广告检测已经处于关闭状态。",
};

/** `/flood_control enable|disable` 的全部文案。 */
export const FLOOD_CONTROL_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群防刷屏禁言的权限。`,
  usage: "用 /flood_control enable 开启，或 /flood_control disable 关闭。",
  enabled: "本群防刷屏禁言已开启。",
  disabled: "本群防刷屏禁言已关闭。",
  alreadyEnabled: "本群防刷屏禁言已经处于开启状态。",
  alreadyDisabled: "本群防刷屏禁言已经处于关闭状态。",
};

/** `/antiraid enable|disable` 的全部文案。 */
export const ANTI_RAID_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群入群验证和防冲群私密模式的权限。`,
  usage: "用 /antiraid enable 开启，或 /antiraid disable 关闭。",
  enabled: "本群入群验证和防冲群私密模式已开启。",
  disabled: "本群入群验证和防冲群私密模式已关闭。",
  alreadyEnabled: "本群入群验证和防冲群私密模式已经处于开启状态。",
  alreadyDisabled: "本群入群验证和防冲群私密模式已经处于关闭状态。",
};

/** `/antiraid disable` 落盘成功、但 Worker 侧运行态没拆干净时的回执。 */
export const ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT: string =
  "入群验证和防冲群已关闭，但已有验证窗口和私密模式未能完成清理。请管理员查看日志，稍后再次关闭。";

/** `/init enable|disable` 的全部文案。 */
export const INIT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群机器人监听的权限。`,
  usage: "用 /init enable 开启，或 /init disable 关闭。",
  enabled: "本群机器人监听已开启。",
  disabled: "本群机器人监听已关闭。",
  alreadyEnabled: "本群机器人监听已经处于开启状态。",
  alreadyDisabled: "本群机器人监听已经处于关闭状态。",
};

/** `/init disable` 已经落盘、但拆运行态失败时的回执。 */
export const INIT_DISABLE_TEARDOWN_FAILED_TEXT: string =
  "本群机器人监听已关闭，但部分运行状态未能完成清理，请管理员查看日志。";

/** `/init enable` 在 State 已达群数上限时的拒绝提示。 */
export const INIT_CHAT_LIMIT_TEXT: string =
  `最多可管理 ${STATE_MANAGED_CHAT_LIMIT} 个群，当前已满。请在不再管理的群执行 /init disable，或将机器人移出该群，再启用本群。仍处于私密模式的群须等待邀请权限恢复后才能释放名额。`;

/** `/block … enable` 的目标解析提示。 */
export const BLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息后发送 /block enable，或使用 /block <@username|用户 id（正整数）> enable。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户 id（正整数）。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息后使用 /block enable。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** `/block … disable` 的目标解析提示。 */
export const UNBLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息后发送 /block disable，或使用 /block <@username|用户 id（正整数）|频道 id（负整数）> disable。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户 id（正整数）或频道 id（负整数）。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息后使用 /block disable。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** `/mute` 的目标解析提示。 */
export const MUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息，或在 /mute 后指定 @username 或用户 id（正整数）。禁言时长必填，例如 /mute @username 10m。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户 id（正整数）。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息后使用 /mute。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** `/unmute` 的目标解析提示。 */
export const UNMUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息，或在 /unmute 后指定 @username 或用户 id（正整数）。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户 id（正整数）。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息后使用 /unmute。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** 共用同一套目标提示文案的命令名。 */
type SharedTargetTextCommand = "copy" | "copy reverse" | "copy nya" | "icon steal";

/** 为一条命令创建模块级目标提示。 */
function createSharedTargetTexts(command: SharedTargetTextCommand): Readonly<CommandTargetMessages> {
  const commandName: string = `/${command}`;
  return {
    missingTarget: `请回复目标消息后发送 ${commandName}，或使用 ${commandName} @username。`,
    invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名，请使用 ${commandName} @username。`,
    unknownUsername: (username: string): string => `尚未记录 @${username}，请让目标先发言，或回复目标消息后发送 ${commandName}。`,
    conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
    selfTarget: "不能将机器人自身设为目标。",
  };
}

/** `/copy` 的目标解析提示。 */
export const COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy");

/** `/copy reverse` 的目标解析提示。 */
export const REVERSE_COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy reverse");

/** `/copy nya` 的目标解析提示。 */
export const NYA_COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy nya");

/** `/icon steal` 的目标解析提示。 */
export const STEAL_ICON_TARGET_TEXTS: Readonly<CommandTargetMessages> =
  createSharedTargetTexts("icon steal");
