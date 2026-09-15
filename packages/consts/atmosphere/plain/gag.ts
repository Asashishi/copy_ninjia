import type { CommandTargetMessages } from "../../../types/commands";

/** gag 开始提示里的发言入口文案。 */
export const GAG_INLINE_SPEAK_BUTTON_TEXT: string = "发言";

/** `/gag` 解析目标失败时使用的临时提示。 */
export const GAG_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息，或在 /gag 后指定 @username 或用户/频道 id。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息或直接提供 id。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};

/** `/ungag` 解析目标失败时使用的临时提示。 */
export const UNGAG_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息，或在 /ungag 后指定 @username 或用户/频道 id。",
  invalidUsername: (argument: string): string => `${argument} 不是完整合法的 Telegram 用户名或用户/频道 id。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息或直接提供 id。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能将机器人自身设为此命令的目标。",
};
