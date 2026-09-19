import type { CommandTargetMessages } from "../../../types/commands";

/** `/info` 的字段标签与提示（普通风格）；回执与提示都在 30 秒后删除。 */
export const INFO_TEXTS: Readonly<{
  nameLabel: string;
  usernameLabel: string;
  idLabel: string;
  noUsername: string;
  noAvatar: string;
  notFound: string;
  busy: string;
}> = {
  nameLabel: "名称：",
  usernameLabel: "用户名：",
  idLabel: "ID：",
  noUsername: "无",
  noAvatar: "头像：无",
  notFound: "查不到这个目标的资料，目标可能不在本群，或机器人无法访问。",
  busy: "查询请求过多，请稍后再试。",
};

/** `/info` 的目标解析提示（普通风格）；目标可以是回复、@username、用户 id 或频道 id。 */
export const INFO_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "请回复目标消息后发送 /info，或使用 /info @username、/info <id>。",
  invalidUsername: (argument: string): string => `${argument} 不是合法的用户名或 id，请使用 /info @username 或 /info <id>。`,
  unknownUsername: (username: string): string => `尚未记录 @${username}，请回复目标消息，或直接使用 id 查询。`,
  conflictingTarget: (argument: string): string => `回复对象与 ${argument} 不一致，请只保留一个目标。`,
  selfTarget: "不能查询机器人自身。",
};
