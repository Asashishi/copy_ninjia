import type { CommandTargetMessages } from "./commands";
import type { WhitelistPermissionKey } from "./identityPolicy";

/** /permission 单项授权回执的入参；changed 决定说「已设为」还是「原本就是」。 */
export interface PermissionSetReplyParams {
  /** 目标身份的展示名。 */
  readonly targetLabel: string;
  /** 本次写入的权限键。 */
  readonly key: WhitelistPermissionKey;
  /** 本次写入的值。 */
  readonly value: boolean;
  /** 落盘是否真的改变了配置。 */
  readonly changed: boolean;
}

/**
 * /permission 的全部对外文案。
 *
 * help 与 query 两条回执都要在正文里嵌一个 JSON 代码块，实体偏移按前缀的
 * UTF-16 长度计算，因此 helpPrefix / queryPrefix **必须以换行结尾**：少了那个
 * 换行，代码块会从开场白的最后一个字符开始，Telegram 渲染出来是错位的。
 * 具体文案表见 packages/consts/whitelist.ts。
 */
export interface PermissionCommandTexts {
  /** 参数形态不对时的固定用法说明。 */
  readonly usage: string;
  /** 权限键或布尔值不合法时的用法说明，额外列出全部可用键。 */
  readonly usageWithKeys: (keys: string) => string;
  /** help 回执里 JSON 代码块之前的开场白；必须以换行结尾。 */
  readonly helpPrefix: string;
  /** help 回执里 JSON 代码块之后的用法清单。 */
  readonly helpSuffix: string;
  /** query 回执里 JSON 代码块之前的开场白；返回值必须以换行结尾。 */
  readonly queryPrefix: (targetLabel: string) => string;
  /** 非超级管理员想改权限配置。 */
  readonly mutationRejection: (actorLabel: string) => string;
  /** 目标是超级管理员自己：权限来自身份，不归白名单表管。 */
  readonly superAdminTarget: string;
  /** 目标解析成了当前群自己的身份（匿名管理员皮套或手滑粘了本群 id）。 */
  readonly currentChatTarget: string;
  /** 目标还不在白名单里，得先 /white。 */
  readonly targetNotWhitelisted: (targetLabel: string) => string;
  /** 写盘失败：白名单记录没有被改动，必须如实说出来而不是让异常掀翻进程。 */
  readonly mutationFailed: string;
  /** all：本次真的把全部权限打开了。 */
  readonly allEnabled: (targetLabel: string) => string;
  /** all：本来就全开着，本次没有改变配置。 */
  readonly allAlreadyEnabled: (targetLabel: string) => string;
  /** 单项授权的结果回执。 */
  readonly permissionSet: (params: PermissionSetReplyParams) => string;
  /** 目标解析失败的分场景文案。 */
  readonly target: CommandTargetMessages;
}

/** /white 的全部对外文案。 */
export interface WhiteCommandTexts {
  /** 参数形态不对时的固定用法说明。 */
  readonly usage: string;
  /** 既不是超级管理员、也没有代加权限的身份想改白名单。 */
  readonly rejection: (actorLabel: string) => string;
  /** 有代加权限的普通白名单身份试图删除成员。 */
  readonly delegatedDisableRejection: string;
  /** 目标是超级管理员自己，且动作是 enable。 */
  readonly superAdminEnable: string;
  /**
   * 目标是超级管理员自己、动作是 disable，且文件里确实有一条残留被清掉。
   *
   * 与 disabled 分开：超级管理员的白名单身份与权限来自 SUPER_ADMIN_USER_ID
   * 本身（见 whitelist.ts 的 isWhitelisted 与
   * getEffectiveWhitelistPermissions），删掉文件里那条残留改变不了其中任何
   * 一样。沿用 disabled 那句「已经被本天才从白名单里踢出去啦」是一份与事实
   * 相反的回执：紧接着 /permission query 仍会打印全开。
   */
  readonly superAdminDisableCleared: string;
  /** 目标是超级管理员自己、动作是 disable，且文件里本来就没有残留条目。 */
  readonly superAdminDisableNoEntry: string;
  /** 目标解析成了当前群自己的身份（匿名管理员皮套或手滑粘了本群 id）。 */
  readonly currentChatTarget: string;
  /** 目标还在黑名单里，得先 /unblock。 */
  readonly blocked: (targetLabel: string) => string;
  /** 写盘失败：白名单没有被改动，必须如实说出来而不是让异常掀翻进程。 */
  readonly mutationFailed: string;
  /** enable：本次真的加进来了，赏一套默认权限。 */
  readonly enabled: (targetLabel: string) => string;
  /** enable：本来就在白名单里，已有权限不会被重置。 */
  readonly alreadyEnabled: (targetLabel: string) => string;
  /** disable：本次真的删掉了。 */
  readonly disabled: (targetLabel: string) => string;
  /** disable：本来就不在白名单里。 */
  readonly alreadyDisabled: (targetLabel: string) => string;
  /** 目标解析失败的分场景文案。 */
  readonly target: CommandTargetMessages;
}
