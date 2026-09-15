import type { CommandTargetMessages, ToggleCommandTexts } from "../../../types/commands";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../translate";

/** /translate 参数错误统一提示。 */
export const TRANSLATE_USAGE_TEXT: string =
  `仅支持文字消息。回复目标后使用 /translate ja|cn|en|uk|ru，或使用 /translate ja|cn|en|uk|ru @username；ja 日语，cn 简体中文，en 美式英语，uk 乌克兰语，ru 俄语。每群最多 ${TRANSLATE_CHAT_USER_LIMIT} 人；/translate list 查看清单；/translate stop 停止全群，回复目标或使用 /translate stop @username/id 停止单人；/translate enable|disable 开关功能。`;

/** 翻译会话容量已满时拒绝新增，既有会话不受影响。 */
export const TRANSLATE_CAPACITY_TEXT: string = "翻译群数已满，请先在不需要翻译的群执行 /translate stop。";

/** 本群翻译人数已满时拒绝新增。 */
export const TRANSLATE_CHAT_CAPACITY_TEXT: string = `本群已达到 ${TRANSLATE_CHAT_USER_LIMIT} 人的翻译上限，请回复目标并执行 /translate stop 释放名额。`;

/** `/translate stop` 不带目标时的全群停止回执。 */
export const TRANSLATE_STOP_ALL_TEXT: string = "已停止本群所有翻译。";

/** 本群翻译开关关闭时拒绝设置方向。 */
export const TRANSLATE_DISABLED_TEXT: string =
  "本群翻译功能未开启，请由具有翻译管理权限的身份执行 /translate enable。";

/** /translate 开关文案。 */
export const TRANSLATE_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `${label} 没有管理本群翻译功能的权限。`,
  usage: TRANSLATE_USAGE_TEXT, enabled: "本群翻译功能已开启，请使用 /translate ja|cn|en|uk|ru 选择语言和目标。",
  disabled: "本群翻译功能已关闭。", alreadyEnabled: "本群翻译功能已经处于开启状态。", alreadyDisabled: "本群翻译功能已经处于关闭状态。",
};

/** /translate 的目标解析文案。 */
export const TRANSLATE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: TRANSLATE_USAGE_TEXT,
  invalidUsername: (argument: string): string => `${argument} 不是合法用户名。${TRANSLATE_USAGE_TEXT}`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请让目标先发言，或回复目标消息指定翻译对象。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个翻译目标。`,
  selfTarget: "不能将机器人自身设为翻译目标。",
};
