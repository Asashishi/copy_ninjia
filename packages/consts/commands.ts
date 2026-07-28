import type { BotCommand } from "@grammyjs/types";

/** 命令处理（packages/commands）的调参常量。 */

/**
 * Telegram 聊天框展示的命令菜单；/send 只供超级管理员私聊使用，故不列入。
 * 命令名只能用拉丁字母、数字和下划线（最长 32 字符），非 ASCII 会被
 * setMyCommands 以 BOT_COMMAND_INVALID 整体拒绝——注意是整份菜单一起失败，
 * 不是跳过那一项。中文动作命令因此进不了菜单，只能靠下面的 /x
 * 这一条纯占位说明项来曝光用法，见 commands/cjkAction.ts。
 */
export const BOT_COMMANDS: readonly BotCommand[] = Object.freeze([
  Object.freeze({ command: "copy", description: "复读" }),
  Object.freeze({ command: "r_copy", description: "复读并反转文本" }),
  Object.freeze({ command: "nya_copy", description: "复读并加喵~" }),
  Object.freeze({ command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" }),
  Object.freeze({ command: "stop_copy", description: "停止当前的复读" }),
  Object.freeze({ command: "steal_icon", description: "偷取目标头像作为 bot 头像" }),
  // 占位说明项：命令名 x 就是那个「变量」，提示用户把它换成任意 1~2 个中文字。
  // 它存在的唯一目的是让中文动作命令在菜单里可见——那类命令名进不了菜单，
  // 见上方说明。收到时由 commands/cjkAction.ts 的 handleCjkActionUsageCommand
  // 回一句用法并终止链路：既不能沉默（点了菜单的人不知道发生了什么），也不能
  // 放行到消息兜底（会被当成普通消息进入 AI/复读流水线）。
  Object.freeze({ command: "x", description: "动作命令：把 x 换成任意 1~2 个中文字直接发，如 /咬、/贴贴；回复 TA 的消息或加 @username 指定对象" }),
  Object.freeze({ command: "block", description: "拉黑：写进永久黑名单并在所有本天才管理的群里踢出封禁，之后再进群秒踢（仅白名单用户可用）" }),
  Object.freeze({ command: "unblock", description: "解除拉黑：把人从永久黑名单里划掉，之后进群不再秒踢；加 all 参数连各群封禁一起解（仅白名单用户可用，all 仅超级管理员）" }),
  Object.freeze({ command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" }),
  Object.freeze({ command: "ad_detect", description: "开关本群广告检测，enable/disable；命中即拉黑并全群封禁删消息（仅限定用户可用）" }),
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

/**
 * `/unblock` 的「连各群封禁一起解」标志。作为独立的一个词出现，与用户名不会
 * 混淆：Telegram 用户名至少 TELEGRAM_USERNAME_MIN_LENGTH 个字符，三个字母的
 * all 永远过不了 USERNAME_ARG_PATTERN。所属模块：commands/unblock.ts。
 */
export const UNBLOCK_ALL_FLAG: string = "all";

/**
 * 中文动作命令（`/咬`、`/贴贴` 等）的匹配规则，见 commands/cjkAction.ts。
 * Telegram 只为 ASCII 命令生成 bot_command 实体，`/咬` 拿不到实体、
 * grammY 的 bot.command 匹配不到，因此改由 bot.hears 直接匹配消息原文。
 * 捕获组 1 是动作词本身，捕获组 2 是可选的 `@BotUsername` 定向后缀。
 * 动作词收 1~2 个中文字：单字覆盖 `/咬`、`/摸`，两字覆盖 `/贴贴`、`/摸摸`
 * 这类叠词与双字动词。命令词后必须紧跟空白或结束，因此 `/咬人人` 这种三字
 * 及以上的写法不算动作命令——`{1,2}` 回溯到一个字后仍接不上空白或结束，
 * 整条正则失配，消息照常回落到普通消息流水线。
 * 字符集覆盖 CJK 基本区、扩展 A 与兼容表意文字；增补平面（扩展 B 及以上）
 * 的生僻字是代理对，不在此列。
 */
export const CJK_ACTION_COMMAND_PATTERN: RegExp =
  /^\/([\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{1,2})(?:@([A-Za-z0-9_]+))?(?:\s|$)/;

/**
 * 动作命令的全局滑动窗口限流：每 CJK_ACTION_RATE_LIMIT_WINDOW_MS（90 秒）
 * 最多应答 450 次，不分群、不分用户合并计数。动作词不需要预先登记，任意
 * 1~2 个中文字都能触发，因此没有命令菜单那层天然约束，需要全局兜底。超额
 * 直接静默丢弃而非排队，也不发提示——限流时再回一条消息等于没限。
 * 队列见 cache/cjkAction.ts，判定见 libs/slidingWindowRateLimit.ts。
 */
export const CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 450;
/** 动作命令全局滑动限频窗口时长。 */
export const CJK_ACTION_RATE_LIMIT_WINDOW_MS: number = 90_000;

/** /quiet 未传时长时使用的分钟数。 */
export const QUIET_DEFAULT_MINUTES: number = 3;
/** /quiet 允许的最短分钟数。 */
export const QUIET_MIN_MINUTES: number = 1;
/** /quiet 允许的最长分钟数。 */
export const QUIET_MAX_MINUTES: number = 15;
/** /quiet 的最大有效持续时间，用于抵御墙钟回拨导致的异常延长。 */
export const QUIET_MAX_DURATION_MS: number = QUIET_MAX_MINUTES * 60_000;
