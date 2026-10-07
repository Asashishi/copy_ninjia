import { DAY_MS } from "./time";

/**
 * 群聊全部非功能性提示统一的延迟删除时长（命令提示与回执、广告警告与处置播报、刷屏禁言、
 * 私密模式、入群验证与 AI 回复的群内提示）。所属模块：infra/telegram 的统一发送与清理边界。
 */
export const COMMAND_MESSAGE_AUTO_DELETE_MS: number = 30_000;

/** `/bot_status` 展示单个模型名标签的最大字符数。 */
export const BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS: number = 96;

/** copy 类命令的公共冷却时长（只有超级管理员本人豁免，白名单不豁免；见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

/**
 * 命令参数接受的用户名最小长度，不含可选的 @ 前缀；
 * 由 USERNAME_ARG_PATTERN 使用，所属模块：commands/targetResolution.ts。
 */
export const TELEGRAM_USERNAME_MIN_LENGTH: number = 5;
/** Telegram 用户名允许的最大长度。 */
export const TELEGRAM_USERNAME_MAX_LENGTH: number = 32;
/**
 * 命令参数按空白切分的规则；消费方是 commands/arguments.ts 的
 * commandArgumentTokens，全仓只此一处切分口径。
 *
 * 非全局正则，`String.prototype.split` 不读写 `lastIndex`，模块级实例可共用；
 * 所属模块：命令参数解析。
 */
export const COMMAND_ARGUMENT_SEPARATOR_PATTERN: RegExp = /\s+/;

/** 命令参数中裸用户名的完整匹配规则。 */
export const USERNAME_ARG_PATTERN: RegExp = new RegExp(
  `^@?([a-zA-Z][a-zA-Z0-9_]{${TELEGRAM_USERNAME_MIN_LENGTH - 2},${TELEGRAM_USERNAME_MAX_LENGTH - 2}}[a-zA-Z0-9])$`
);

/**
 * 命令参数中裸用户 id 的完整匹配规则：十进制正整数，不接受正负号、前导零、
 * 指数与小数；最终的安全整数边界由调用方统一判定。
 *
 * 与 USERNAME_ARG_PATTERN 互斥（Telegram 用户名以字母开头）。**只认正数**：负数 id 是会话身份，
 * 由 CHAT_ID_ARG_PATTERN 按命令开关处理（见 commands/targetResolution.ts）。
 * 位数不在这里限制，调用方还要过一次 `Number.isSafeInteger`。
 */
export const USER_ID_ARG_PATTERN: RegExp = /^[1-9]\d*$/;

/**
 * 命令参数中裸会话 id（频道/群）的完整匹配规则：带负号的十进制整数，同样不接受
 * 前导零、指数与小数，位数边界由调用方的 `Number.isSafeInteger` 判定。
 *
 * 不限定 -100 前缀。libs/telegramId.ts 负责数值解析，commands/targetResolution.ts
 * 通过 acceptChatId 控制各命令是否接受这种目标形态。
 */
export const CHAT_ID_ARG_PATTERN: RegExp = /^-[1-9]\d*$/;

/**
 * 「这不是合法用户名」提示里回显参数原文的最大字符数。
 *
 * 提示语在回显前后拼固定文案，该上限使整条提示不超过 TELEGRAM_MESSAGE_MAX_CHARS。
 * 所属模块：commands/targetResolution.ts。
 */
export const INVALID_USERNAME_ECHO_MAX_CHARS: number = TELEGRAM_USERNAME_MAX_LENGTH * 2;

/**
 * 中文动作命令（`/咬`、`/贴贴` 等）的匹配规则，见 commands/cjkAction.ts。
 * Telegram 只为 ASCII 命令生成 bot_command 实体，由 bot.hears 直接匹配消息原文。
 * 捕获组 1 是动作词本身，捕获组 2 是可选的 `@BotUsername` 定向后缀。
 * 动作词为 1~2 个中文字：单字如 `/咬`，叠词与双字动词如 `/贴贴`。命令词后必须紧跟空白或结束，
 * `/咬人人` 这种三字及以上的写法整条失配，消息回落到普通消息流水线。
 * 字符集覆盖 CJK 基本区、扩展 A 与兼容表意文字；增补平面的字是代理对，不在此列。
 */
export const CJK_ACTION_COMMAND_PATTERN: RegExp =
  /^\/([\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{1,2})(?:@([A-Za-z0-9_]+))?(?:\s|$)/;

/**
 * 「/」的 UTF-16 码元。app/registerHandlers.ts 用它给中文动作命令的 hears 子链做
 * 外闸：CJK_ACTION_COMMAND_PATTERN 以 `^\/` 开头，原文首字符不是它的消息不进子链。
 */
export const SLASH_CHAR_CODE: number = 0x2f;

/**
 * 动作命令的全局滑动窗口限流：每个 CJK_ACTION_RATE_LIMIT_WINDOW_MS 窗口内
 * 最多应答的次数，不分群、不分用户合并计数。超额静默丢弃，不排队也不发提示。
 * 队列见 cache/main/cjkAction.ts，判定见 libs/slidingWindowRateLimit.ts。
 */
export const CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 450;
/** 动作命令全局滑动限频窗口时长。 */
export const CJK_ACTION_RATE_LIMIT_WINDOW_MS: number = 90_000;

/**
 * 时长参数的完整匹配规则：正整数（不接受前导零/小数/正负号）紧跟一个单位
 * 字母，m=分钟、h=小时、d=天，大小写均可。捕获组 1 是数值、组 2 是单位。
 * 数值位数不设限，换算成毫秒后由各命令自己的上限收敛或拒绝。所属模块：libs/durationToken.ts（`/mute`、`/batch_kick` 与 cron.json 的
 * `rand_cron` 区间共用）。
 */
export const DURATION_TOKEN_PATTERN: Readonly<RegExp> = /^([1-9]\d*)([mhd])$/i;

/**
 * 时长单位到毫秒的换算表，键集合与 DURATION_TOKEN_PATTERN 的单位捕获组一一
 * 对应，新增单位两处要同步改。所属模块：libs/durationToken.ts；`commands/quiet.ts`、
 * `commands/gag/runtime.ts` 也按它换算分钟。
 */
export const DURATION_UNIT_MS: Readonly<Record<"m" | "h" | "d", number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: DAY_MS,
};

/**
 * `/mute` 允许的最短时长。Bot API 对 restrictChatMember 的约定是 `until_date`
 * 距现在不足官方下限按永久禁言处理；本值高于该下限，本进程不为永久禁言排恢复计时器。
 *
 * 「命令处理到请求真正发出」之间的排队（restrict 类 429 按 `retry_after` 排队）不由这条下限约束，
 * 由派发截止兑现，见 MUTE_DISPATCH_MIN_REMAINING_MS。所属模块：commands/mute.ts。
 */
export const MUTE_MIN_DURATION_MS: number = 60_000;

/**
 * `/mute` 为禁言截止时刻预留的剩余时长；派发预算为「本次时长 − 本常量」，到期取消请求。
 * 所属模块：commands/mute.ts；
 * 派发截止与 Telegram 禁言边界见 docs/cn/04-invariants.md。
 */
export const MUTE_DISPATCH_MIN_REMAINING_MS: number = 45_000;

/**
 * `/mute` 的最长时长，超出时由 commands/mute.ts 收敛到本上限。
 * 截止时刻交给 Telegram，本进程不保存恢复计时器；禁言边界见 docs/cn/04-invariants.md。
 */
export const MUTE_MAX_DURATION_MS: number = 365 * DAY_MS;

/** `/batch_kick` 最短回溯窗口。 */
export const BATCH_KICK_MIN_DURATION_MS: number = 60_000;

/** `/batch_kick` 最长回溯窗口；回溯范围按配置时区的自然日合并查询入群日志。 */
export const BATCH_KICK_MAX_DURATION_MS: number = DAY_MS;

/**
 * `/batch_kick` 同时执行的 Telegram 成员查询/踢出任务数。
 */
export const BATCH_KICK_CONCURRENCY: number = 5;

/**
 * 跨托管群处置同时运行的群数（`/block` 的连坐封禁与 `/block disable` 的跨群解封）。
 * 两条命令共用同一份群清单与并发上限。
 * 所属模块：infra/blocklist/membership.ts 的 runManagedChatBatch。
 */
export const MANAGED_CHAT_BATCH_CONCURRENCY: number = 5;

/** /quiet 未传时长时使用的分钟数。 */
export const QUIET_DEFAULT_MINUTES: number = 3;
/** /quiet 允许的最短分钟数。 */
export const QUIET_MIN_MINUTES: number = 1;
/** /quiet 允许的最长分钟数。 */
export const QUIET_MAX_MINUTES: number = 15;
/**
 * /quiet 时长参数的形态：只接受 ASCII 十进制整数；小数、正负号、`0x5`、`1e1` 一律回用法提示。
 * 所属模块：commands/quiet.ts。
 */
export const QUIET_MINUTES_PATTERN: RegExp = /^\d+$/;
/** /quiet 的最大有效持续时间；剩余时长超出它加 QUIET_CLOCK_SKEW_TOLERANCE_MS 时视为墙钟回拨，由 libs/chatState.ts 的 normalizeChatState 收敛。 */
export const QUIET_MAX_DURATION_MS: number = QUIET_MAX_MINUTES * 60_000;

/**
 * `/quiet` 剩余时长判定在最大值之上额外容忍的墙钟回拨量。
 *
 * `handleQuietCommand` 写入 `Date.now() + minutes * 60_000`，顶格时
 * `quietUntil - now` 等于 QUIET_MAX_DURATION_MS；本值为小幅回拨留出余量。超出容差的大幅回拨由
 * libs/chatState.ts 的 normalizeChatState 收敛到上限，不删除字段。
 * 所属模块：libs/chatState.ts。
 */
export const QUIET_CLOCK_SKEW_TOLERANCE_MS: number = 60_000;
