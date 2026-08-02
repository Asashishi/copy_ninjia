import type { BotCommand } from "@grammyjs/types";

/** 群聊命令文本发送后自动清理的最长保留时间。 */
export const COMMAND_MESSAGE_AUTO_DELETE_MS: number = 30_000;

/** 命令处理（packages/commands）的调参常量。 */

/**
 * Telegram 聊天框展示的命令菜单；/send 只供超级管理员私聊使用，故不列入。
 * 命令名只能用拉丁字母、数字和下划线（最长 32 字符），非 ASCII 会被
 * setMyCommands 以 BOT_COMMAND_INVALID 整体拒绝——注意是整份菜单一起失败，
 * 不是跳过那一项。中文动作命令因此进不了菜单，只能靠下面的 /x
 * 这一条纯占位说明项来曝光用法，见 commands/cjkAction.ts。
 */
export const BOT_COMMANDS: readonly Readonly<BotCommand>[] = [
  { command: "copy", description: "复读" },
  { command: "r_copy", description: "复读并反转文本" },
  { command: "nya_copy", description: "复读并加喵~" },
  { command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" },
  { command: "stop_copy", description: "停止当前的复读" },
  { command: "steal_icon", description: "偷取目标头像作为 bot 头像" },
  // 占位说明项：命令名 x 就是那个「变量」，提示用户把它换成任意 1~2 个中文字。
  // 它存在的唯一目的是让中文动作命令在菜单里可见——那类命令名进不了菜单，
  // 见上方说明。收到时由 commands/cjkAction.ts 的 handleCjkActionUsageCommand
  // 回一句用法并终止链路：既不能沉默（点了菜单的人不知道发生了什么），也不能
  // 放行到消息兜底（会被当成普通消息进入 AI/复读流水线）。
  { command: "x", description: "动作命令：把 x 换成任意 1~2 个中文字直接发，如 /咬、/贴贴；回复 TA 的消息或加 @username 指定对象" },
  { command: "block", description: "拉黑：写进永久黑名单并在所有本天才管理的群里踢出封禁，之后再进群秒踢；回复消息、@username 或直接给用户 id 指定目标（仅白名单用户可用）" },
  { command: "unblock", description: "完整解除拉黑：移出永久黑名单并解除所有托管群封禁；支持回复消息、@username、用户 id 或频道的负数 id（仅白名单用户可用）" },
  { command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" },
  { command: "ad_detect", description: "开关本群广告检测，enable/disable；命中即拉黑并全群封禁删消息（仅限定用户可用）" },
  { command: "flood_control", description: "开关本群防刷屏禁言，enable/disable（仅限定用户可用）" },
  { command: "query_mood", description: "查询本群 AI 的当前心情（群成员可用）" },
  { command: "switch_mood", description: "重新抽一个本群 AI 的当前心情（仅限定用户可用）" },
  { command: "init", description: "开关本群的机器人监听/初始化，enable/disable（仅限定用户可用）" },
  { command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" },
  { command: "unquiet", description: "提前解除 /quiet 静默" },
  { command: "mute", description: "禁言：收走目标的发言权一段时间，时长必填，如 10m、2h、1d（1 分钟~366 天，到点自动恢复）；回复消息、@username 或用户 id 指定目标（仅白名单用户可用）" },
  { command: "unmute", description: "提前解除禁言；回复消息、@username 或用户 id 指定目标（仅白名单用户可用）" },
  { command: "batch_kick", description: "批量踢出本群滚动时间窗内加入的人，如 30m、2h、1d；只踢不拉黑（仅超级管理员可用）" },
  { command: "permission", description: "query 查询自身权限，help 查看说明；修改白名单权限仅超级管理员可用" },
  { command: "white", description: "新增或删除白名单用户/频道，首次加入使用默认权限（仅超级管理员可用）" },
];

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
 * 命令参数中裸用户 id 的完整匹配规则：十进制正整数，不接受正负号、前导零、
 * 指数与小数（口径与 libs/runtimeConfig.ts 解析 `.env` 里那批 id 的一致）。
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
 * `/unblock`、`/permission` 与 `/white` 按需打开这条路（`acceptChatId`）。
 * 前者必须保证黑名单里的频道马甲始终能被划掉；后两者管理的白名单本来就允许
 * 负数频道 ID，不能强迫管理员依赖一条仍存在的频道消息或公开 username。
 *
 * 反方向的 `/block` 继续拒绝负数：把粘错的会话 id 当目标会改去封整个会话身份，
 * 而那条命令不可逆；其余三条都是可恢复的配置操作。
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
 * `/mute` 时长参数的完整匹配规则：正整数（不接受前导零/小数/正负号）紧跟
 * 一个单位字母，m=分钟、h=小时、d=天，大小写均可。捕获组 1 是数值、组 2 是
 * 单位。数值位数不设限：正则挡不住安全整数边界，换算成毫秒后由
 * MUTE_MAX_DURATION_MS 的收敛兜底（见 commands/mute.ts）。
 */
export const MUTE_DURATION_ARG_PATTERN: RegExp = /^([1-9]\d*)([mhd])$/i;

/**
 * `/mute` 时长单位到毫秒的换算表，键集合与 MUTE_DURATION_ARG_PATTERN 的单位
 * 捕获组一一对应，新增单位两处要同步改。所属模块：commands/mute.ts。
 */
export const MUTE_DURATION_UNIT_MS: Readonly<Record<"m" | "h" | "d", number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

/**
 * `/mute` 允许的最短时长。Bot API 对 restrictChatMember 的约定是 `until_date`
 * 距现在不足 30 秒按永久禁言处理；时长单位最小是分钟，1 分钟天然越过这条
 * 线，同时给「命令处理到请求真正发出」之间的排队留出余量——被收成永久禁言
 * 的话本进程不排恢复计时器，只能人工解除。所属模块：commands/mute.ts。
 */
export const MUTE_MIN_DURATION_MS: number = 60_000;

/**
 * `/mute` 允许的最长时长。Bot API 同一条约定的另一头：`until_date` 距现在
 * 超过 366 天同样按永久禁言处理，收敛在 366 天整正好落在临时禁言的合法区间
 * 内。所属模块：commands/mute.ts。
 */
export const MUTE_MAX_DURATION_MS: number = 366 * 24 * 60 * 60_000;

/**
 * `/batch_kick` 回溯时长的完整匹配规则：正整数加 m/h/d，大小写均可。
 * 入群日志提供滚动 24 小时窗口，因此换算后超过一天的参数由命令拒绝。
 */
export const BATCH_KICK_DURATION_ARG_PATTERN: RegExp = /^([1-9]\d*)([mhd])$/i;

/** `/batch_kick` 时长单位到毫秒的换算表。 */
export const BATCH_KICK_DURATION_UNIT_MS: Readonly<Record<"m" | "h" | "d", number>> =
  {
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };

/** `/batch_kick` 最短回溯窗口，避免零长度或秒级误操作。 */
export const BATCH_KICK_MIN_DURATION_MS: number = 60_000;

/** `/batch_kick` 最长回溯窗口；查询最多合并两个东京自然日。 */
export const BATCH_KICK_MAX_DURATION_MS: number = 24 * 60 * 60_000;

/**
 * `/batch_kick` 同时执行的 Telegram 成员查询/踢出任务数。
 * 命令是低频管理操作，固定小并发可避免大群清理时瞬间打满 Bot API。
 */
export const BATCH_KICK_CONCURRENCY: number = 5;

/** /quiet 未传时长时使用的分钟数。 */
export const QUIET_DEFAULT_MINUTES: number = 3;
/** /quiet 允许的最短分钟数。 */
export const QUIET_MIN_MINUTES: number = 1;
/** /quiet 允许的最长分钟数。 */
export const QUIET_MAX_MINUTES: number = 15;
/** /quiet 的最大有效持续时间，用于抵御墙钟回拨导致的异常延长。 */
export const QUIET_MAX_DURATION_MS: number = QUIET_MAX_MINUTES * 60_000;
