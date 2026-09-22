import type { CommandTargetMessages } from "../../../types/commands";

/** `/info` 的字段标签与提示（嘲讽风格）；回执与提示都在 30 秒后删除。 */
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
  notFound: "查不到这个目标的资料呀，TA 不在这个群里，还是本天才根本不认识？杂鱼换个目标吧♡",
  busy: "一口气查这么多人，本天才忙不过来啦，杂鱼等会儿再来♡",
};

/** `/info` 的目标解析提示（嘲讽风格）；目标可以是回复、@username、用户 id 或频道 id。 */
export const INFO_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: "笨蛋，要么回复 TA 的一条消息再 /info，要么写 /info @username 或 /info <id>，本天才总得知道查谁吧♡",
  invalidUsername: (rawArgument: string): string =>
    `笨蛋，${rawArgument} 既不是合法的用户名也不是 id 呀，写成 /info @username 或 /info <id> 再来♡`,
  unknownUsername: (rawUsername: string): string =>
    `@${rawUsername} 还没在本天才面前说过话呢，回复 TA 的消息或者直接用 id 查吧，杂鱼♡`,
  conflictingTarget: (rawArgument: string): string =>
    `笨蛋，你回复了一条消息、又写了 ${rawArgument}，本天才该查哪个呀？只留一个再来♡`,
  selfTarget: "笨蛋，本天才查自己做什么呀♡",
};
