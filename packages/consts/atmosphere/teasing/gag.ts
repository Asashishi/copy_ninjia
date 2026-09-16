import type { CommandTargetMessages } from "../../../types/commands";

/** gag 开始提示里的发言入口文案。 */
export const GAG_INLINE_SPEAK_BUTTON_TEXT: string = "发言";

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
