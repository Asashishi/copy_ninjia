/** 命令处理（src/commands）的调参常量。 */

/** Telegram 聊天框展示的命令菜单；/send 只供超级管理员私聊使用，故不列入。 */
export const BOT_COMMANDS = [
  { command: "copy", description: "复读" },
  { command: "r_copy", description: "复读并反转文本" },
  { command: "nya_copy", description: "复读并加喵~" },
  { command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" },
  { command: "stop_copy", description: "停止当前的复读" },
  { command: "steal_icon", description: "偷取目标头像作为 bot 头像" },
  { command: "kick", description: "在所有本天才管理的群里踢出并封禁（仅白名单用户可用）" },
  { command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" },
  { command: "init", description: "开关本群的机器人监听/初始化，enable/disable（仅限定用户可用）" },
  { command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" },
  { command: "unquiet", description: "提前解除 /quiet 静默" },
] as const;

/** copy 类命令的公共冷却时长（白名单用户豁免，见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

/**
 * 从命令参数里解析裸 @username（如 "/copy @foo" 的 "@foo"）的正则，
 * 见 commands/targetResolution.ts 的 resolveCommandTarget。规则与 Telegram
 * 普通用户名一致：5~32 位、字母开头、只含字母/数字/下划线且不以下划线结尾。
 */
export const TELEGRAM_USERNAME_MIN_LENGTH: number = 5;
export const TELEGRAM_USERNAME_MAX_LENGTH: number = 32;
export const USERNAME_ARG_PATTERN: RegExp = new RegExp(
  `^@?([a-zA-Z][a-zA-Z0-9_]{${TELEGRAM_USERNAME_MIN_LENGTH - 2},${TELEGRAM_USERNAME_MAX_LENGTH - 2}}[a-zA-Z0-9])$`
);

// /quiet 静默时长：默认值与上下限（分钟）。
export const QUIET_DEFAULT_MINUTES: number = 3;
export const QUIET_MIN_MINUTES: number = 1;
export const QUIET_MAX_MINUTES: number = 15;
