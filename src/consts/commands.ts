import type { BotCommand } from "@grammyjs/types";

/** 命令处理（src/commands）的调参常量。 */

/** Telegram 聊天框展示的命令菜单；/send 只供超级管理员私聊使用，故不列入。 */
export const BOT_COMMANDS: readonly BotCommand[] = Object.freeze([
  Object.freeze({ command: "copy", description: "复读" }),
  Object.freeze({ command: "r_copy", description: "复读并反转文本" }),
  Object.freeze({ command: "nya_copy", description: "复读并加喵~" }),
  Object.freeze({ command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" }),
  Object.freeze({ command: "stop_copy", description: "停止当前的复读" }),
  Object.freeze({ command: "steal_icon", description: "偷取目标头像作为 bot 头像" }),
  Object.freeze({ command: "kick", description: "在所有本天才管理的群里踢出并封禁（仅白名单用户可用）" }),
  Object.freeze({ command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" }),
  Object.freeze({ command: "switch_mood", description: "重新抽一个本群 AI 的当前心情（仅限定用户可用）" }),
  Object.freeze({ command: "init", description: "开关本群的机器人监听/初始化，enable/disable（仅限定用户可用）" }),
  Object.freeze({ command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" }),
  Object.freeze({ command: "unquiet", description: "提前解除 /quiet 静默" }),
]);

/** copy 类命令的公共冷却时长（白名单用户豁免，见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

/**
 * 从命令参数里解析裸 @username（如 "/copy @foo" 的 "@foo"）的正则，
 * 见 commands/targetResolution.ts 的 resolveCommandTarget。规则与 Telegram
 * 普通用户名一致：5~32 位、字母开头、只含字母/数字/下划线且不以下划线结尾。
 */
export const TELEGRAM_USERNAME_MIN_LENGTH: number = 5;
/** Telegram 用户名允许的最大长度。 */
export const TELEGRAM_USERNAME_MAX_LENGTH: number = 32;
/** 命令参数中裸用户名的完整匹配规则。 */
export const USERNAME_ARG_PATTERN: RegExp = new RegExp(
  `^@?([a-zA-Z][a-zA-Z0-9_]{${TELEGRAM_USERNAME_MIN_LENGTH - 2},${TELEGRAM_USERNAME_MAX_LENGTH - 2}}[a-zA-Z0-9])$`
);

/** /quiet 未传时长时使用的分钟数。 */
export const QUIET_DEFAULT_MINUTES: number = 3;
/** /quiet 允许的最短分钟数。 */
export const QUIET_MIN_MINUTES: number = 1;
/** /quiet 允许的最长分钟数。 */
export const QUIET_MAX_MINUTES: number = 15;
/** /quiet 的最大有效持续时间，用于抵御墙钟回拨导致的异常延长。 */
export const QUIET_MAX_DURATION_MS: number = QUIET_MAX_MINUTES * 60_000;
