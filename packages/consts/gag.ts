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

/** gag 按钮预填查询的保留前缀；只有频道身份在后面追加目标 id 与会话令牌。 */
export const GAG_INLINE_QUERY_PREFIX: string = "gag:";

/** 频道预填查询里分隔目标 id 与会话令牌的字符；两侧形态互不重叠。 */
export const GAG_INLINE_TOKEN_SEPARATOR: string = ":";

/**
 * 频道发言入口的一次性会话令牌字节数。
 *
 * 频道身份没有「查询者 id」可比对（Telegram 从不告诉本进程皮套背后是谁），
 * 令牌就是那个绑定：它只随群内那条带按钮的开始提示分发，因此只有看得见按钮的
 * 群成员拿得到。少了它，任何人 `@bot gag:<频道 id> x` 就能读到 inline 结果里
 * 用 chatLabel 拼出的「在 <群名称> 发言」——一次针对私有群标题的信息泄露。
 * 8 字节（64 位）对一个最长 15 分钟、全局至多 5 条的会话足够，且预填串足够短，
 * 不会明显挤占 GAG_INLINE_QUERY_MAX_CHARS 留给正文的额度。
 */
export const GAG_INLINE_TOKEN_BYTES: number = 8;

/** 会话令牌的唯一合法形态：固定长度小写十六进制。 */
export const GAG_INLINE_TOKEN_PATTERN: Readonly<RegExp> = new RegExp(
  `^[0-9a-f]{${GAG_INLINE_TOKEN_BYTES * 2}}$`
);

/** 频道 inline 结果用 text_link 携带目标频道 id 的固定地址前缀。 */
export const GAG_INLINE_CHANNEL_LINK_PREFIX: string = "https://t.me/#gag-channel=";

/** 允许继续追加在原文字形后的唯一填充内容。 */
export const GAG_ELLIPSIS_FILLER: string = "...";

/** 25% 替换分支均匀抽取的字符；只替换原字形，不再追加到它后面。 */
export const GAG_REPLACEMENT_CHARACTERS: readonly string[] = [
  "唔",
  "啊",
  "嗯",
  "哦",
  "齁",
  "咕",
];

/**
 * 原字形后追加省略号的概率；剩余概率走 GAG_REPLACEMENT_CHARACTERS 替换分支。
 * 两个分支由 gag/rendering.ts 的 `roll < GAG_ELLIPSIS_PROBABILITY` 单条判定切分，
 * 不再单列替换分支常量——那份常量没有生产消费者，改这一个时它不会跟着动，
 * 却会让测试继续按 0.75 + 0.25 推导出一条早已偏离实现的阈值。
 */
export const GAG_ELLIPSIS_PROBABILITY: number = 0.75;

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
