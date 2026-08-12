import type { CommandTargetMessages } from "../types/commands";
import type { GagDurationMinutes } from "../types/gag";

/** `/gag` command 域的容量、时长、文案渲染与 inline 素材常量。 */

/** 主线程全局最多同时维护的 gag 会话数；starting 与 ending 同样计入。 */
export const GAG_SESSION_MAX: number = 5;

/**
 * gag 开始提示删除遇到瞬时失败后的有限重试间隔；耗尽后仍保留 ending owner，
 * 等 `/ungag`、chat teardown 或进程停机再次触发，不做无限轮询。
 */
export const GAG_CLEANUP_RETRY_DELAYS_MS: readonly number[] = [
  1_000,
  5_000,
  30_000,
];

/** `/gag` 接受的分钟数；命令不把其它正数收敛到边界。 */
export const GAG_DURATION_MINUTES: readonly (5 | 10 | 15)[] = [5, 10, 15];

/** `/gag` 省略时长时采用的分钟数；必须属于 GAG_DURATION_MINUTES。 */
export const GAG_DEFAULT_DURATION_MINUTES: GagDurationMinutes = 5;

/** `/gag` 时长位置上的纯数字形态；命中但不在允许集合时必须拒绝。 */
export const GAG_DURATION_TOKEN_PATTERN: RegExp = /^\d+$/;

/** 未指定 gag 用具时使用的名称。 */
export const GAG_DEFAULT_TOOL: string = "口塞";

/** inline 查询正文的 Telegram 官方 UTF-16 长度上限。 */
export const GAG_INLINE_QUERY_MAX_CHARS: number = 256;

/** gag 开始提示里的发言入口文案。 */
export const GAG_INLINE_SPEAK_BUTTON_TEXT: string = "发言";

/** 每个发言入口在本群经过多少条新消息后滚动换新；各会话独立计数。 */
export const GAG_SPEAK_NOTICE_MESSAGE_INTERVAL: number = 15;

/**
 * gag 查询的唯一协议前缀；其后 scope 只能是目标 Telegram ID。
 * 禁止追加摘要、随机 token、群 ID 或其它元数据；群绑定只走隐藏 marker 与落群校验。
 */
export const GAG_INLINE_QUERY_PREFIX: string = "gag:";

/** gag 隐藏主页链接挂载目标所在超级群 ID 时使用的 URL fragment 分隔符。 */
export const GAG_PROFILE_CHAT_SEPARATOR: string = "#";

/** 有公开 username 的用户或频道主页前缀。 */
export const GAG_PUBLIC_PROFILE_LINK_PREFIX: string = "https://t.me/";

/** 公开 username 链接明确打开身份主页而不是对话时使用的查询参数。 */
export const GAG_PUBLIC_PROFILE_QUERY: string = "?profile";

/** 无公开 username 的频道按 Bot API 对话 ID 定位主页时使用的前缀。 */
export const GAG_PRIVATE_CHANNEL_PROFILE_LINK_PREFIX: string = "https://t.me/c/";

/** 私有频道链接使用首条消息作为稳定入口；裸 `t.me/c/<id>` 不是官方消息链接。 */
export const GAG_PRIVATE_CHANNEL_ENTRY_MESSAGE_ID: number = 1;

/** 无公开 username 的用户通过 Bot API ID 打开个人主页时使用的前缀。 */
export const GAG_USER_PROFILE_LINK_PREFIX: string = "tg://user?id=";

/** gag 填充使用的单个点字符；点之间可按概率插入一个 ASCII 空格。 */
export const GAG_FILLER_DOT: string = ".";

/** 一次 gag 填充最少生成的点数。 */
export const GAG_FILLER_MIN_DOTS: number = 3;

/** 一次 gag 填充最多生成的点数。 */
export const GAG_FILLER_MAX_DOTS: number = 6;

/** 相邻两个填充点之间插入一个 ASCII 空格的独立概率。 */
export const GAG_FILLER_GAP_SPACE_PROBABILITY: number = 1 / 3;

/** 六个点且每个点间都有空格时的最坏 UTF-16 长度，用于发送上限预检。 */
export const GAG_FILLER_MAX_CHARS: number = GAG_FILLER_MAX_DOTS * 2 - 1;

/** 25% 替换候选均匀抽取的字符；只替换原字形，不再追加到它后面。 */
export const GAG_REPLACEMENT_CHARACTERS: readonly string[] = [
  "唔",
  "啊",
  "嗯",
  "哦",
  "齁",
  "咕",
];

/**
 * 候选操作选择填充的概率；剩余概率走 GAG_REPLACEMENT_CHARACTERS 替换分支。
 * 两个分支由 gag/rendering.ts 的 `roll < GAG_FILL_OPERATION_PROBABILITY` 单条判定切分，
 * 不再单列替换分支常量——那份常量没有生产消费者，改这一个时它不会跟着动，
 * 却会让测试继续按 0.75 + 0.25 推导出一条早已偏离实现的阈值。连续操作闸门
 * 可以挡住候选，因此该值描述抽样概率，不承诺最终文本中的填充占比。
 */
export const GAG_FILL_OPERATION_PROBABILITY: number = 0.75;

/** 同类填充或替换最多连续作用于两个相邻字形，第三次候选必须被闸门处理。 */
export const GAG_MAX_CONSECUTIVE_SAME_OPERATIONS: number = 2;

/**
 * 短文本操作保底档位；元素依次为「字形数上界（不含）」与「最少操作数」。
 * 2~3、4~7、8~31、32~64 个字形分别至少操作 2、3、7、15 次；超过 64 不保底。
 */
export const GAG_MIN_OPERATION_TIERS: readonly (
  readonly [upperExclusive: number, minimumOperations: number]
)[] = [
  [4, 2],
  [8, 3],
  [32, 7],
  [65, 15],
];

/** inline 列表里的群名和用具摘要上限，防止用户字段撑坏客户端预览。 */
export const GAG_INLINE_LABEL_MAX_CHARS: number = 96;

/** `/gag` 解析目标失败时使用的临时提示。 */
export const GAG_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget:
    "连要管教谁都没告诉本天才，真是没用♡ 回复目标消息，或者把 @username、用户/频道 id 写上啦，杂鱼♡",
  invalidUsername: (rawArgument: string): string =>
    `噗，${rawArgument} 既不是合法的 Telegram 用户名，也不是用户/频道 id，连目标都写不对呀，笨蛋♡`,
  unknownUsername: (rawUsername: string): string =>
    `@${rawUsername} 还没被本天才记住哦，乖乖回复 TA 的消息或直接给用户/频道 id 啦，杂鱼♡`,
  conflictingTarget: (rawArgument: string): string =>
    `回复了一个身份又写 ${rawArgument}，到底想 gag 谁呀？说话都说不明白的杂鱼♡`,
  selfTarget: "哈？还想 gag 本天才？杂鱼再做一百年梦也不可能啦♡",
};

/** `/ungag` 解析目标失败时使用的临时提示。 */
export const UNGAG_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget:
    "连要给谁解开都不说，真是没用的杂鱼♡ 回复目标消息，或者在 /ungag 后写 @username、用户/频道 id 啦♡",
  invalidUsername: (rawArgument: string): string =>
    `噫，${rawArgument} 既不是合法的 Telegram 用户名，也不是用户/频道 id，这样可解不了哦，笨蛋♡`,
  unknownUsername: (rawUsername: string): string =>
    `@${rawUsername} 还没被本天才记住哦，回复 TA 的消息或直接给用户/频道 id 啦，杂鱼♡`,
  conflictingTarget: (rawArgument: string): string =>
    `回复了一个身份又写 ${rawArgument}，到底想放谁呀？说清楚一点，杂鱼♡`,
  selfTarget: "哈？本天才又没被 gag，杂鱼在解什么呢♡",
};
