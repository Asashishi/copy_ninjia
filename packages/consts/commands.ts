/** 群聊命令文本发送后自动清理的最长保留时间。 */
export const COMMAND_MESSAGE_AUTO_DELETE_MS: number = 30_000;

/** `/bot_status` 展示单个 provider/model 标签的最大字符数，防止部署值撑破消息上限。 */
export const BOT_STATUS_CAPABILITY_LABEL_MAX_CHARS: number = 96;

/** copy 类命令的公共冷却时长（只有超级管理员本人豁免，白名单不豁免；见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
export const COPY_COOLDOWN_MS: number = 5 * 60 * 1000;

/**
 * 从命令参数里解析裸 @username（如 "/copy @foo" 的 "@foo"）的正则，
 * 见 commands/targetResolution.ts 的 resolveCommandTarget。规则与 Telegram
 * 普通用户名一致：5~32 位、字母开头、只含字母/数字/下划线且不以下划线结尾。
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
 * `/gag`、`/ungag`、`/unblock`、`/permission` 与 `/white` 按需打开这条路
 *（`acceptChatId`）。前两条用它直接指定频道 sender_chat；`/unblock` 必须保证
 * 黑名单里的频道马甲始终能被划掉；后两者管理的白名单本来就允许负数频道 ID，
 * 不能强迫管理员依赖一条仍存在的频道消息或公开 username。
 *
 * 反方向的 `/block` 继续拒绝负数：把粘错的会话 id 当目标会改去封整个会话身份，
 * 而那条命令不可逆；其余调用都是可恢复的运行时或配置操作。
 * 不限定 `-100` 前缀：这条口子存在的意义正是「名单上的东西一定划得掉」，
 * 不该再留下一类划不掉的 id。
 */
export const CHAT_ID_ARG_PATTERN: RegExp = /^-[1-9]\d*$/;

/**
 * 「这不是合法用户名」提示里回显参数原文的最大字符数。
 *
 * 参数原文只受 Telegram 单条消息 4096 字符的限制，而提示语还要在它前后拼上固定
 * 文案——原样插回去拼出的就是一条超过 4096 的出站消息，Telegram 直接 400，
 * `runTelegramAction` 把它吞进日志后返回 undefined：用户收到的是彻底的沉默而不是
 * 这句嘲讽，而命令的限频名额早就在调用方扣掉了。上限取用户名最大长度的两倍
 * ——回显只是为了让人看清自己打错了什么，比合法用户名长一截就足够了。
 * 所属模块：commands/targetResolution.ts。
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
 * `/mute` 的请求真正发出时，`until_date` 距当下必须仍然剩下的时长。
 *
 * 派发截止取「本次时长 − 本常量」：超时即放弃这次禁言，按「Telegram 这会儿
 * 不理本天才」如实回执。不设它的话，一条 `/mute @x 1m` 撞上 restrict 类 429
 * 退避就会在发出那一刻落进「不足 30 秒即永久」区间，被静默升级成只能人工
 * `/unmute` 的永久禁言，而战报照常念「到点自动松开」。
 *
 * 取 45 秒而不是刷屏禁言那侧的 60 秒（FLOOD_MUTE_DISPATCH_TIMEOUT_MS）：那边
 * 的时长恒为 3 分钟，这边的下限是 MUTE_MIN_DURATION_MS（1 分钟），留 60 秒
 * 等于把 1 分钟那一档的派发窗口压成 0，`/mute @x 1m` 从此永远发不出去。45 秒
 * 仍比那条 30 秒红线宽出半程，1 分钟那一档也还剩 15 秒可以排队。
 * 所属模块：commands/mute.ts。
 */
export const MUTE_DISPATCH_MIN_REMAINING_MS: number = 45_000;

/**
 * `/mute` 允许的最长时长。Bot API 同一条约定的另一头：`until_date` 距现在
 * 超过 366 天同样按永久禁言处理。
 *
 * 上限取 365 天而不是贴着 366 天的边：Bot API 是按**它收到请求的时刻**算这
 * 个差值的，命令处理、restrict 类 429 退避和网络往返都会把 `until_date` 相对「现在」
 * 往前推；而 muteChatMemberWithOutcome 还要向上取整到秒，又加最多 1 秒。贴顶
 * 时这些余量全部溢出到 366 天之外，禁言被静默升级成永久——本进程不排恢复
 * 计时器、不写任何持久化状态，除人工 /unmute 外永不解除，而战报却照常念
 * 「到点自动松开」。留一整天余量把这条边界彻底移出可达范围。
 * 所属模块：commands/mute.ts。
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
 * 跨托管群处置同时运行的群数（`/block` 的连坐封禁与 `/unblock` 的跨群解封）。
 *
 * 单租户通常只有约 15 个群，但配置状态仍可能长期增长；固定小并发避免一次命令
 * 把全部群同时展开成 Telegram 请求和闭包，也避免逐群串行让 update 中间件几十次
 * 往返都不返回。两条命令是同一处置的正反面，读同一份群清单、用同一个上限——
 * 拆成两个数值早晚会漂移出「封的时候并发、解的时候串行」这种不对称。
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
 * `quietUntil - now` 恰好等于 QUIET_MAX_DURATION_MS，容差为零：主机时钟往回
 * 跳哪怕 1 毫秒（NTP step、`chronyc makestep`、快照恢复、容器时钟同步——本仓
 * 在 libs/slidingWindowRateLimit.ts 与 workers/antiRaid/floodControl.ts 里都把
 * 回拨当作必须扛住的真实风险），顶格那条静默就整个失效。留出这一分钟让常见的
 * 小幅回拨不改变任何判定；超出容差的大幅回拨由 libs/chatState.ts 的
 * normalizeChatState 收敛到上限，而不是把字段删掉。
 * 所属模块：commands/quiet.ts 与 libs/chatState.ts。
 */
export const QUIET_CLOCK_SKEW_TOLERANCE_MS: number = 60_000;
