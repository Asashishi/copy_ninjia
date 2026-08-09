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

/** 单次 answerInlineQuery 最多允许返回的结果数。 */
export const GAG_INLINE_PAGE_SIZE: number = 50;

/** gag 开始提示里的发言入口文案。 */
export const GAG_INLINE_SPEAK_BUTTON_TEXT: string = "发言";

/** gag 按钮预填查询的保留前缀；只有频道身份在后面追加目标 id。 */
export const GAG_INLINE_QUERY_PREFIX: string = "gag:";

/** 频道 inline 结果用 text_link 携带目标频道 id 的固定地址前缀。 */
export const GAG_INLINE_CHANNEL_LINK_PREFIX: string = "https://t.me/#gag-channel=";

/** 50% 概率选中的主要填充词。 */
export const GAG_PRIMARY_FILLER: string = "...";

/** 剩余 50% 均分的五个填充词，因此每项概率为 10%。 */
export const GAG_SECONDARY_FILLERS: readonly string[] = ["唔", "啊", "嗯", "哦", "齁"];

/** 每个随机填充词后固定追加的半角空格；它不参与概率抽取。 */
export const GAG_FILLER_SUFFIX: string = " ";

/** 主填充词的概率边界；随机值小于它时选 `...`。 */
export const GAG_PRIMARY_FILLER_PROBABILITY: number = 0.5;

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
