/** 群聊非功能性命令提示的延迟删除时长；发送边界见 infra/telegram。 */
export const COMMAND_MESSAGE_AUTO_DELETE_MS: number = 30_000;

/** `/bot_status` 展示单个模型名标签的最大字符数，防止部署值撑破消息上限。 */
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
 * 非全局正则，`String.prototype.split` 也不读写 `lastIndex`，因此可以安全地共用
 * 这一个模块级实例；所属模块：命令参数解析。
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
 * 与 USERNAME_ARG_PATTERN 天然互斥——Telegram 用户名必须字母开头——所以两者
 * 谁先匹配都不会抢到对方的参数。**只认正数**：负数 id 是会话身份，处置语义完全
 * 不同，单独走 CHAT_ID_ARG_PATTERN 那条按命令开关的路（见
 * commands/targetResolution.ts）。位数不在这里限制：正则管不了安全整数边界，
 * 调用方拿到之后还要过一次 `Number.isSafeInteger`。
 */
export const USER_ID_ARG_PATTERN: RegExp = /^[1-9]\d*$/;

/**
 * 命令参数中裸会话 id（频道/群）的完整匹配规则：带负号的十进制整数，同样不接受
 * 前导零、指数与小数，位数边界仍由调用方的 `Number.isSafeInteger` 兜底。
 *
 * 不限定 -100 前缀。libs/telegramId.ts 负责数值解析，commands/targetResolution.ts
 * 通过 acceptChatId 控制各命令是否接受这种目标形态。
 */
export const CHAT_ID_ARG_PATTERN: RegExp = /^-[1-9]\d*$/;

/**
 * 「这不是合法用户名」提示里回显参数原文的最大字符数。
 *
 * 参数原文只受 Telegram 单条消息 4096 字符的限制，而提示语还要在它前后拼上固定
 * 文案；不设上限时拼接结果可能超过 4096 触发 Telegram 400，`runTelegramAction`
 * 吞掉错误后返回 undefined，提示语整条静默丢失。所属模块：commands/targetResolution.ts。
 */
export const INVALID_USERNAME_ECHO_MAX_CHARS: number = TELEGRAM_USERNAME_MAX_LENGTH * 2;

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
 * 「/」的 UTF-16 码元。app/registerHandlers.ts 用它给中文动作命令的 hears 子链做
 * 外闸：CJK_ACTION_COMMAND_PATTERN 以 `^\/` 开头，原文首字符不是它的消息不进子链。
 */
export const SLASH_CHAR_CODE: number = 0x2f;

/**
 * 动作命令的全局滑动窗口限流：每 CJK_ACTION_RATE_LIMIT_WINDOW_MS（90 秒）
 * 最多应答 450 次，不分群、不分用户合并计数。动作词不需要预先登记，任意
 * 1~2 个中文字都能触发，因此没有命令菜单那层天然约束，需要全局兜底。超额
 * 直接静默丢弃而非排队，也不发提示——限流时再回一条消息等于没限。
 * 队列见 cache/main/cjkAction.ts，判定见 libs/slidingWindowRateLimit.ts。
 */
export const CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW: number = 450;
/** 动作命令全局滑动限频窗口时长。 */
export const CJK_ACTION_RATE_LIMIT_WINDOW_MS: number = 90_000;

/**
 * 时长参数的完整匹配规则：正整数（不接受前导零/小数/正负号）紧跟一个单位
 * 字母，m=分钟、h=小时、d=天，大小写均可。捕获组 1 是数值、组 2 是单位。
 * 数值位数不设限：正则挡不住安全整数边界，换算成毫秒后由各命令自己的上限
 * 收敛或拒绝兜底。所属模块：libs/durationToken.ts（`/mute` 与 `/batch_kick` 共用）。
 */
export const DURATION_TOKEN_PATTERN: Readonly<RegExp> = /^([1-9]\d*)([mhd])$/i;

/**
 * 时长单位到毫秒的换算表，键集合与 DURATION_TOKEN_PATTERN 的单位捕获组一一
 * 对应，新增单位两处要同步改。所属模块：libs/durationToken.ts。
 */
export const DURATION_UNIT_MS: Readonly<Record<"m" | "h" | "d", number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

/**
 * `/mute` 允许的最短时长。Bot API 对 restrictChatMember 的约定是 `until_date`
 * 距现在不足 30 秒按永久禁言处理；时长单位最小是分钟，1 分钟天然越过这条
 * 线——被收成永久禁言的话本进程不排恢复计时器，只能人工解除。
 *
 * 「命令处理到请求真正发出」之间的排队不由这条下限兜：那段等待没有上界
 * （restrict 类 429 按 `retry_after` 排队），只能由派发截止兑现，见
 * MUTE_DISPATCH_MIN_REMAINING_MS。所属模块：commands/mute.ts。
 */
export const MUTE_MIN_DURATION_MS: number = 60_000;

/**
 * `/mute` 为禁言截止时刻预留的剩余时长；派发预算为「本次时长 − 本常量」。
 * 最短 1 分钟禁言对应 15 秒派发预算，到期取消请求。所属模块：commands/mute.ts；
 * 派发截止与 Telegram 禁言边界见 docs/cn/04-invariants.md。
 */
export const MUTE_DISPATCH_MIN_REMAINING_MS: number = 45_000;

/**
 * `/mute` 的最长时长为 365 天，超出时由 commands/mute.ts 收敛到本上限。
 * 截止时刻交给 Telegram，本进程不保存恢复计时器；禁言边界见 docs/cn/04-invariants.md。
 */
export const MUTE_MAX_DURATION_MS: number = 365 * 24 * 60 * 60_000;

/** `/batch_kick` 最短回溯窗口，避免零长度或秒级误操作。 */
export const BATCH_KICK_MIN_DURATION_MS: number = 60_000;

/** `/batch_kick` 最长回溯窗口；查询最多合并两个东京自然日。 */
export const BATCH_KICK_MAX_DURATION_MS: number = 24 * 60 * 60_000;

/**
 * `/batch_kick` 同时执行的 Telegram 成员查询/踢出任务数。
 * 命令是低频管理操作，固定小并发可避免大群清理时瞬间打满 Bot API。
 */
export const BATCH_KICK_CONCURRENCY: number = 5;

/**
 * 跨托管群处置同时运行的群数（`/block` 的连坐封禁与 `/block disable` 的跨群解封）。
 * 两条命令共用同一份群清单与同一个并发上限，不单独各设一份。
 * 所属模块：infra/blocklist/membership.ts 的 runManagedChatBatch。
 */
export const MANAGED_CHAT_BATCH_CONCURRENCY: number = 5;

/** /quiet 未传时长时使用的分钟数。 */
export const QUIET_DEFAULT_MINUTES: number = 3;
/** /quiet 允许的最短分钟数。 */
export const QUIET_MIN_MINUTES: number = 1;
/** /quiet 允许的最长分钟数。 */
export const QUIET_MAX_MINUTES: number = 15;
/** /quiet 的最大有效持续时间，用于抵御墙钟回拨导致的异常延长。 */
export const QUIET_MAX_DURATION_MS: number = QUIET_MAX_MINUTES * 60_000;

/**
 * `/quiet` 剩余时长判定在最大值之上额外容忍的墙钟回拨量。
 *
 * `handleQuietCommand` 写的是 `Date.now() + minutes * 60_000`，顶格时
 * `quietUntil - now` 恰好等于 QUIET_MAX_DURATION_MS，容差为零，主机时钟任何
 * 回拨都会让顶格判定失效；本值为小幅回拨留出余量。超出容差的大幅回拨由
 * libs/chatState.ts 的 normalizeChatState 收敛到上限，不删除字段。
 * 所属模块：commands/quiet.ts 与 libs/chatState.ts。
 */
export const QUIET_CLOCK_SKEW_TOLERANCE_MS: number = 60_000;
