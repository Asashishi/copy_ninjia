import type { CommandTargetMessages, ToggleCommandTexts } from "../../../types/commands";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../translate";

/** /translate 参数错误统一提示。 */
export const TRANSLATE_USAGE_TEXT: string =
  `笨蛋，本天才只处理文字消息。回复目标后用 /translate ja|cn|en|uk|ru，或 /translate ja|cn|en|uk|ru @username；ja 日语，cn 简体中文，en 美式英语，uk 乌克兰语，ru 俄语。每群最多 ${TRANSLATE_CHAT_USER_LIMIT} 人，查看语言用 /translate list；直接用 /translate stop 停止全群，回复目标或用 /translate stop @username/id 停止单人，功能开关用 /translate enable|disable♡`;

/** 翻译会话容量已满时拒绝新增，既有会话不受影响。 */
export const TRANSLATE_CAPACITY_TEXT: string = "翻译群数已满啦，先在不用翻译的群 /translate stop，再来开启，笨蛋♡";

/** 本群翻译人数已满时拒绝新增。 */
export const TRANSLATE_CHAT_CAPACITY_TEXT: string = `本群已经有 ${TRANSLATE_CHAT_USER_LIMIT} 个杂鱼等本天才翻译啦，回复目标用 /translate stop 腾个位置再来♡`;

/** `/translate stop` 不带目标时的全群停止回执。 */
export const TRANSLATE_STOP_ALL_TEXT: string = "本群所有杂鱼的翻译都停止啦，需要时再来求本天才♡";

/** 本群翻译开关关闭时拒绝设置方向。 */
export const TRANSLATE_DISABLED_TEXT: string =
  "本群翻译功能还没开启，找有翻译管理权限的人 /translate enable 一下吧♡";

/** /translate 开关文案。 */
export const TRANSLATE_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `就 ${label} 也想管本天才要不要翻译？没这项权限呀，笨蛋♡`,
  usage: TRANSLATE_USAGE_TEXT,
  enabled: "本天才已开启本群翻译，用 /translate ja|cn|en|uk|ru 选方向和目标吧♡",
  disabled: "本群翻译功能已关闭，杂鱼需要时再来开启♡",
  alreadyEnabled: "本群翻译功能本来就开着啦，用 /translate ja|cn|en|uk|ru 开始吧♡",
  alreadyDisabled: "本群翻译功能本来就关着啦，笨蛋♡",
};

/** /translate 的目标解析文案。 */
export const TRANSLATE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: TRANSLATE_USAGE_TEXT,
  invalidUsername: (argument: string): string => `笨蛋，${argument} 不是合法用户名。${TRANSLATE_USAGE_TEXT}`,
  unknownUsername: (username: string): string => `本天才还不认识 @${username}，先让 TA 发言，或回复 TA 的消息指定翻译目标♡`,
  conflictingTarget: (argument: string): string => `回复目标和 ${argument} 不一致，只留一个翻译目标，笨蛋♡`,
  selfTarget: "本天才不能把自己设成翻译目标呀，笨蛋♡",
};
