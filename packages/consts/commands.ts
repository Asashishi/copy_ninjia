import type { BotCommand } from "@grammyjs/types";
import type { CommandTargetMessages, ToggleCommandTexts } from "../types/commands";

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
  { command: "copy", description: "让本天才复读你的消息，连这都要点菜单吗，杂鱼♡" },
  { command: "r_copy", description: "让本天才反转文本再复读，倒着看可别把自己绕晕哦，杂鱼♡" },
  { command: "nya_copy", description: "让本天才复读并加上喵~，这点可爱也要来蹭吗，杂鱼♡" },
  { command: "ja_copy", description: "复读并翻成日语；enable/disable 开关本群功能，只有获授权者配碰，杂鱼别乱按♡" },
  { command: "stop_copy", description: "停掉当前复读，终于发现自己很吵了吗，杂鱼♡" },
  { command: "steal_icon", description: "偷取目标头像给本天才换上，连自己的头像都拿不出手吗，杂鱼♡" },
  // 占位说明项：命令名 x 就是那个「变量」，提示用户把它换成任意 1~2 个中文字。
  // 它存在的唯一目的是让中文动作命令在菜单里可见——那类命令名进不了菜单，
  // 见上方说明。收到时由 commands/cjkAction.ts 的 handleCjkActionUsageCommand
  // 回一句用法并终止链路：既不能沉默（点了菜单的人不知道发生了什么），也不能
  // 放行到消息兜底（会被当成普通消息进入 AI/复读流水线）。
  { command: "x", description: "把 x 换成任意 1~2 个中文字直接发，如 /咬、/贴贴；回复 TA 或加 @username 指定目标，笨蛋♡" },
  { command: "block", description: "把目标写进永久黑名单并在所有托管群封禁，之后再进群也秒踢；支持回复、@username 或用户 id，仅白名单用户配用，杂鱼别乱碰♡" },
  { command: "unblock", description: "把目标移出永久黑名单并解除所有托管群封禁；支持回复、@username、用户 id 或频道负数 id，仅白名单用户配用，笨蛋♡" },
  { command: "ai_chat", description: "用 enable/disable 开关本群 AI 闲聊，只有获授权者配使唤本天才，杂鱼别乱按♡" },
  { command: "ad_detect", description: "用 enable/disable 开关本群广告检测；命中就拉黑并全群封禁删消息，只有获授权者配碰，杂鱼♡" },
  { command: "flood_control", description: "用 enable/disable 开关本群防刷屏禁言，只有获授权者配碰，刷屏杂鱼可别手抖哦♡" },
  { command: "query_mood", description: "偷看本群 AI 当前心情，群成员都能问，连本天才的脸色都不会看吗，杂鱼♡" },
  { command: "switch_mood", description: "重新抽取本群 AI 心情，只有获授权者配左右本天才，杂鱼别得意♡" },
  { command: "init", description: "用 enable/disable 开关本群机器人监听/初始化，只有限定用户配决定本天才管不管，杂鱼♡" },
  { command: "quiet", description: "让本天才安静 1~15 分钟，默认 3 分钟；嫌吵就自己说清楚呀，笨蛋♡" },
  { command: "unquiet", description: "提前解除 /quiet，让本天才重新开口；这么快就想我了吗，杂鱼♡" },
  { command: "mute", description: "禁言目标一段时间，时长必填如 10m/2h/1d（1 分钟~365 天，到点恢复）；支持回复、@username 或用户 id，仅白名单用户配用，杂鱼♡" },
  { command: "unmute", description: "提前解除目标禁言；支持回复、@username 或用户 id，仅白名单用户配用，连等到期都做不到吗，杂鱼♡" },
  { command: "batch_kick", description: "踢出本群滚动时间窗内加入的人，如 30m/2h/1d；只踢不拉黑，仅超级管理员配用，杂鱼围观就好♡" },
  { command: "permission", description: "query 偷看自己有几斤几两，help 看本天才的说明；改权限只有超级管理员配碰，杂鱼别乱按♡" },
  { command: "white", description: "新增或删除白名单用户/频道，首次加入用默认权限；仅超级管理员配用，普通杂鱼别想偷偷混进来♡" },
];

/** copy 类命令的公共冷却时长（白名单边界内的身份豁免，含恒在边界内的超级管理员；见 commands/copyShared.ts 的 claimCopyCooldownOrReject）。 */
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
 * 超过 366 天同样按永久禁言处理。
 *
 * 上限取 365 天而不是贴着 366 天的边：Bot API 是按**它收到请求的时刻**算这
 * 个差值的，命令处理、每群限流排队和网络往返都会把 `until_date` 相对「现在」
 * 往前推；而 muteChatMemberWithOutcome 还要向上取整到秒，又加最多 1 秒。贴顶
 * 时这些余量全部溢出到 366 天之外，禁言被静默升级成永久——本进程不排恢复
 * 计时器、不写任何持久化状态，除人工 /unmute 外永不解除，而战报却照常念
 * 「到点自动松开」。留一整天余量把这条边界彻底移出可达范围。
 * 所属模块：commands/mute.ts。
 */
export const MUTE_MAX_DURATION_MS: number = 365 * 24 * 60 * 60_000;

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

/**
 * enable/disable 开关命令的对外文案表。
 *
 * 五条命令各一张，字段口径见 packages/types/commands.ts 的 ToggleCommandTexts：
 * 拒绝、用法、以及四种状态结局各自的回执。它们跨调用方共享同一个对象，由
 * `Readonly<>` 在编译期锁住全部字段（不可变性只在编译期表达，见 AGENTS.md 的
 * 「常量」一节；断言在 `test/consts/immutability.test.ts`）。
 * 所属模块：packages/commands/superAdminToggle.ts 与各开关命令。
 */

/** `/ai_chat enable|disable` 的全部文案。 */
export const AI_CHAT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才要不要闲聊？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /ai_chat enable 还是 /ai_chat disable，说清楚呀♡`,
  enabled: `哼，那本天才就赏脸在这个群闲聊几句吧，杂鱼们好好珍惜♡`,
  disabled: `本天才不想再理你们这群杂鱼了，闲聊到此为止♡`,
  alreadyEnabled: `笨蛋，本天才本来就在这个群陪你们闲聊呀，还要本天才答应几次？♡`,
  alreadyDisabled: `本天才本来就没在这个群闲聊呀，笨蛋要关什么呢♡`,
};

/** `/ad_detect enable|disable` 的全部文案。 */
export const AD_DETECT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才抓不抓广告？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /ad_detect enable 还是 /ad_detect disable，说清楚呀♡`,
  enabled: `哼，本天才这就盯着这个群的广告，敢发的杂鱼一个都别想留下♡`,
  disabled: `不抓广告了，随便你们刷吧，本天才可懒得管♡`,
  alreadyEnabled: `笨蛋，本天才本来就盯着这个群的广告呢，还要本天才多长几只眼睛吗？♡`,
  alreadyDisabled: `本天才本来就没在抓这个群的广告呀，笨蛋要关什么呢♡`,
};

/** `/flood_control enable|disable` 的全部文案。 */
export const FLOOD_CONTROL_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才抓不抓刷屏？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /flood_control enable 还是 /flood_control disable，说清楚呀♡`,
  enabled: `哼，本天才开始盯着这个群的刷屏杂鱼了，刷太快就等着被按住吧♡`,
  disabled: `防刷屏关掉了，随便你们吵吧，本天才懒得管♡`,
  alreadyEnabled: `笨蛋，本天才本来就盯着这个群的刷屏杂鱼呢，急什么呀♡`,
  alreadyDisabled: `防刷屏本来就是关着的呀，笨蛋要关几次才甘心♡`,
};

/**
 * `/ja_copy enable|disable` 的全部文案。用法提示要额外说清不带参数是复读翻译：
 * 这条命令的两种用法共用同一个命令名，靠有没有参数区分（见 commands/jaCopy.ts）。
 */
export const JA_COPY_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才要不要翻译日语？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，/ja_copy 不带参数是复读翻译，要开关这个功能就 /ja_copy enable 或 /ja_copy disable，说清楚呀♡`,
  enabled: `哼，那本天才就赏脸继续在这个群用 /ja_copy 翻译日语吧，杂鱼们好好珍惜♡`,
  disabled: `本天才不想再给你们这群杂鱼翻译日语了，/ja_copy 到此为止♡`,
  alreadyEnabled: `笨蛋，本天才本来就在这个群翻日语呀，直接用 /ja_copy 不就好了♡`,
  alreadyDisabled: `本天才本来就没在这个群翻日语呀，笨蛋要关什么呢♡`,
};

/** `/init enable|disable` 的全部文案；这条是超级管理员独占的群总开关。 */
export const INIT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想让本天才在这个群干活？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /init enable 还是 /init disable，说清楚呀♡`,
  enabled: `哼，那本天才就大发慈悲开始搭理这个群了，杂鱼们好好珍惜♡`,
  disabled: `本天才不想再理这个群了，爱干嘛干嘛去吧♡`,
  alreadyEnabled: `笨蛋，本天才本来就在搭理这个群呀，还要本天才答应几次？♡`,
  alreadyDisabled: `本天才本来就没在理这个群呀，笨蛋要关什么呢♡`,
};

/**
 * `/init disable` 已经落盘、但拆运行态失败时的回执。
 *
 * 这条路必须有自己的话：总开关此刻确实已经durable 地关掉了（重启后网关照样
 * 拦住这个群），只是 copy 槽、AI 记忆或 Anti-Raid 那边有一样没拆干净。既不能
 * 说成干净的成功，也不能把异常放出去——那会让 acknowledged runner 带非零码
 * 退出且不确认 offset，Telegram 重投同一条命令，而那时 wasEnabled 已经是
 * false，管理员反而会收到一句「本来就关着」。所属模块：packages/commands/init.ts。
 */
export const INIT_DISABLE_TEARDOWN_FAILED_TEXT: string =
  `本天才不想再理这个群了，爱干嘛干嘛去吧——不过有几样运行态没能拆干净，` +
  `日志里写着呢，杂鱼管理员去看一眼♡`;

/**
 * 各命令的目标解析提示文案表。
 *
 * 字段口径见 packages/types/commands.ts 的 CommandTargetMessages。抽成模块级
 * 单例而不是每次调用现造：原来的写法每次命令调用都要新建一个对象加三个闭包，
 * 而这些文案与本次调用的任何入参都无关。
 *
 * 注意 `/x` 那批中文动作命令**不在此列**：它们的提示里嵌着用户现打的动作词
 * （任意 1~2 个中文字，见 CJK_ACTION_COMMAND_PATTERN），既没有有限的键集合可
 * 建表，也不能按动作词缓存——那等于开一份键完全由外部输入决定的无界缓存。
 * 所属模块：packages/commands/ 下各命令。
 */

/** `/block` 的目标解析提示；只认正整数用户 id，负数会话 id 另有语义。 */
export const BLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /block @username 或 /block 用户id，要么回复 TA 的一条消息再 /block，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数，群和频道那种负数 id 不算），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /block 吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；封人这事本天才可不猜——想封谁就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才才不会把自己拉黑呢♡`,
};

/** `/unblock` 的目标解析提示；这条命令额外认频道的负数 id。 */
export const UNBLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /unblock @username 或 /unblock 用户id（频道就给那串负数 id），要么回复 TA 的一条消息再 /unblock，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是 id（用户是正整数，频道是那串负数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /unblock 吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想解封谁就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才本来就没把自己拉黑呀♡`,
};

/** `/mute` 的目标解析提示；除动词外与 /block 的口径一致。 */
export const MUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /mute @username 或 /mute 用户id，要么回复 TA 的一条消息，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再来吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想对谁动手就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才才不会捂自己的嘴呢♡`,
};

/** `/unmute` 的目标解析提示；与 MUTE_TARGET_TEXTS 只差命令名那一处动词。 */
export const UNMUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /unmute @username 或 /unmute 用户id，要么回复 TA 的一条消息，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再来吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想对谁动手就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才才不会捂自己的嘴呢♡`,
};

/** `/copy` 的目标解析提示。 */
export const COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /copy @username，要么直接回复 TA 的一条消息再 /copy，本天才总得知道杂鱼是谁吧♡`,
  invalidUsername: (rawArgument: string): string =>
    `笨蛋，${rawArgument} 才不是完整合法的 Telegram 用户名呀，要写成 /copy @username，别在后面夹垃圾♡`,
  unknownUsername: (rawUsername: string): string =>
    `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 /copy 呀♡`,
  conflictingTarget: (rawArgument: string): string =>
    `笨蛋，你回复了一条消息、又写了 ${rawArgument}，本天才该盯上哪个杂鱼呀？只留一个再来♡`,
  selfTarget: `笨蛋，本天才怎么可能盯上自己呀♡`,
};

/** `/steal_icon` 的目标解析提示；与 COPY_TARGET_TEXTS 只差命令名。 */
export const STEAL_ICON_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /steal_icon @username，要么直接回复 TA 的一条消息再 /steal_icon，本天才总得知道杂鱼是谁吧♡`,
  invalidUsername: (rawArgument: string): string =>
    `笨蛋，${rawArgument} 才不是完整合法的 Telegram 用户名呀，要写成 /steal_icon @username，别在后面夹垃圾♡`,
  unknownUsername: (rawUsername: string): string =>
    `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 /steal_icon 呀♡`,
  conflictingTarget: (rawArgument: string): string =>
    `笨蛋，你回复了一条消息、又写了 ${rawArgument}，本天才该盯上哪个杂鱼呀？只留一个再来♡`,
  selfTarget: `笨蛋，本天才怎么可能盯上自己呀♡`,
};
