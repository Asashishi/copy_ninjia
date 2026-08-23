import type { MessageEntity } from "@grammyjs/types";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/identityPolicy";
import type { SetWhitelistPermissionResult } from "../infra/identityPolicy/whitelist";
import { forumTopicThreadId } from "../libs/forumTopic";
import {
  PERMISSION_COMMAND_TEXTS,
  WHITELIST_PERMISSION_ALL_COMMAND,
  WHITELIST_PERMISSION_HELP_COMMAND,
  WHITELIST_PERMISSION_HELP_JSON,
  WHITELIST_PERMISSION_KEY_BY_LOWERCASE,
  WHITELIST_PERMISSION_KEYS,
  WHITELIST_PERMISSION_QUERY_COMMAND,
} from "../consts/whitelist";
import {
  confirmWhitelistEntryPersisted,
  enableAllWhitelistPermissions,
  getWhitelistPermissionQueryView,
  isWhitelisted,
  setWhitelistPermission,
} from "../infra/identityPolicy/whitelist";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

interface PermissionHelpMessage {
  text: string;
  entities: readonly MessageEntity[];
}

/**
 * 前缀 + JSON 代码块 + 可选后缀。
 *
 * 三段都用具名字段而不是位置参数：它们同为 string，位置写反不会报错，只会让
 * 下面那对 offset/length 指到错误的区间——而那正是这次收拢要防的东西。
 */
export interface FormatJsonBlockMessageParams {
  prefix: string;
  /** 要渲染成 `pre` 代码块的那一段；offset/length 按它算。 */
  permissionJson: string;
  /** 代码块之后追加的说明；query 回执不需要，传空串。 */
  suffix: string;
}

/**
 * 前缀 + JSON 代码块的统一渲染。
 *
 * 两个调用点（help 与 query）此前各写一份同样的 `entities` 字面量，而那里最容易
 * 出错的恰好是 offset/length 这对数：它们按 **UTF-16 code unit** 计，写死成别的
 * 长度不会报错，只会让 Telegram 把代码块画歪或整段吞掉。收在一处之后，两条回执
 * 的实体只有一个真相来源。
 */
function formatJsonBlockMessage({
  prefix,
  permissionJson,
  suffix,
}: FormatJsonBlockMessageParams): PermissionHelpMessage {
  return {
    text: `${prefix}${permissionJson}${suffix}`,
    entities: [
      {
        type: "pre",
        offset: prefix.length,
        length: permissionJson.length,
        language: "json",
      },
    ],
  };
}

/** 把权限键与说明渲染为可复制的 JSON 代码块，实体偏移按 UTF-16 code unit 计算。 */
function formatPermissionHelpMessage(): PermissionHelpMessage {
  return formatJsonBlockMessage({
    prefix: PERMISSION_COMMAND_TEXTS.helpPrefix,
    permissionJson: WHITELIST_PERMISSION_HELP_JSON,
    suffix: `\n${PERMISSION_COMMAND_TEXTS.helpSuffix}`,
  });
}

/**
 * 把目标身份的完整权限渲染为 JSON 代码块。
 *
 * 与 `help` 一样长期保留：这份回执是一张要照着逐项核对的权限看板，30 秒清理会
 * 在人读完之前把它收走，于是只能反复重发同一条命令。用户已明确授权这条例外，
 * 调用点显式传 `preserveInGroup: true`（见 AGENTS.md 的「Telegram 提示留存」）。
 */
function formatPermissionQueryMessage(
  permissions: Readonly<WhitelistPermissions>,
  targetLabel: string
): PermissionHelpMessage {
  return formatJsonBlockMessage({
    prefix: PERMISSION_COMMAND_TEXTS.queryPrefix(targetLabel),
    permissionJson: JSON.stringify(permissions, null, 2),
    suffix: "",
  });
}

/** 大小写不敏感地还原为配置中的规范权限键。 */
export function parseWhitelistPermissionKey(
  raw: string
): WhitelistPermissionKey | undefined {
  const normalized: string = raw.toLowerCase();
  return WHITELIST_PERMISSION_KEY_BY_LOWERCASE.get(normalized);
}

/** 只接受字面量 true/false，避免 1、yes 等形态日后出现多套口径。 */
export function parsePermissionBoolean(raw: string): boolean | undefined {
  const normalized: string = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/** reportWhitelistMutationFailure 的入参。 */
interface ReportWhitelistMutationFailureParams {
  /** 回执发往的会话。 */
  readonly chatId: number;
  /** 命令消息 id，回执回复到它下面。 */
  readonly messageId: number | undefined;
  /** 本次要改的身份，只用于日志定位。 */
  readonly targetId: number;
  /** 写盘抛出的原始错误。 */
  readonly error: unknown;
}

/**
 * 白名单写盘失败时就地降级：记一行错误日志并如实回执。
 *
 * 不能让异常逸出 handler。bot.catch 按设计原样重抛（见 app/registerHandlers.ts），
 * acknowledged runner 随即让进程带非零码退出且**不确认 offset**，Telegram 重投
 * 同一条命令、同一处再抛——`database/` 不可写时一条 /permission 就能把机器人锁进
 * 永久重启循环，所有群一起失能。
 *
 * 确认这条 update 是安全的：失败可能发生在投递、事务 flush 或精确 ACK 边界，
 * 但最终值都已作为未 ACK revision 留在主线程 LRU 里，幂等重试与 Worker 重建
 * 都会重放。因此回执只说「没写进硬盘」，不谎称权限已经改好。降级语义与
 * antiRaid/blocklistGuard.ts 的 claimBlockedJoiner、commands/white.ts 一致。
 */
async function reportWhitelistMutationFailure({
  chatId,
  messageId,
  targetId,
  error,
}: ReportWhitelistMutationFailureParams): Promise<void> {
  logger.error(
    `Failed to persist the whitelist permission change for identity ${targetId}:`,
    error
  );
  await sendCommandMessage({
    chatId,
    text: PERMISSION_COMMAND_TEXTS.mutationFailed,
    replyToMessageId: messageId,
  });
}

/**
 * 处理 /permission：所有身份都可查看说明并查询自身或指定用户的权限；仅超级
 * 管理员可修改已经存在的白名单条目。
 *
 * 新增/删除成员由 /white 负责；其中持有 isCanWhiteOther 的普通成员只能新增
 * 默认权限条目，删除和本命令的逐项授权仍仅限超级管理员，避免把权限委托继续
 * 扩大成可传递的管理边界。
 *
 * 超级管理员在这条命令里出现在两个位置，语义相反：作为**发起人**他是唯一能改
 * 权限的人；作为**目标**则一律被拒——他的权限来自身份、恒为全开，写进配置文件
 * 的条目永远不会被读到（见 whitelist.ts 的 getEffectiveWhitelistPermissions）。
 */
export async function handlePermissionCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  // 直接比对上面已经解析出来的发起身份，不再调 isSuperAdminActor 重解析一遍：
  // resolveCommandActor 对同一个 ctx 是纯函数，第二次调用只多造一个 CachedUser。
  const actorIsSuperAdmin: boolean = actor?.id === SUPER_ADMIN_USER_ID;
  const tokens: string[] = ctx.match.trim()
    .split(/\s+/)
    .filter((token: string): boolean => token.length > 0);
  const isHelp: boolean =
    tokens.length === 1 &&
    tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_HELP_COMMAND;
  const isQuery: boolean =
    tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_QUERY_COMMAND;

  if (isHelp) {
    const helpMessage: PermissionHelpMessage = formatPermissionHelpMessage();
    await sendCommandMessage({
      chatId,
      text: helpMessage.text,
      entities: helpMessage.entities,
      replyToMessageId: messageId,
      preserveInGroup: true,
      // 长期保留的看板必须自己带话题，理由见 SendMessageParams.messageThreadId。
      messageThreadId: forumTopicThreadId(ctx.msg),
    });
    return;
  }

  if (isQuery) {
    const rawTargetArgument: string = tokens.slice(1).join(" ");
    let target: CachedUser | undefined = actor;
    if (rawTargetArgument.length > 0 || ctx.msg.reply_to_message !== undefined) {
      target = await resolveCommandTarget({
        chatId,
        message: ctx.msg,
        botUserId: ctx.me.id,
        rawArgument: rawTargetArgument,
        acceptUserId: true,
        // 与下面的授权分支保持同一道解析口径。缺了它，`resolveArgumentTarget`
        // 跳过 parseChatIdArgument，而 USERNAME_ARG_PATTERN 匹配不了前导 `-`，
        // 于是 `/permission query -100…` 被回成「不是合法用户名」——刚用
        // `/permission -100… isCanBlock true` 授过权的频道身份反而读不回来。
        acceptChatId: true,
        messages: PERMISSION_COMMAND_TEXTS.target,
      });
    }
    if (target === undefined) return;

    // 这里只读预热后的主线程 LRU；非白名单身份复用逐项 false 的静态视图，
    // 不为一次查询创建或写入数据库条目。超级管理员则由配置边界返回全开视图。
    const permissions: Readonly<WhitelistPermissions> =
      getWhitelistPermissionQueryView(target.id);
    const queryMessage: PermissionHelpMessage = formatPermissionQueryMessage(
      permissions,
      formatTargetLabel(target)
    );
    await sendCommandMessage({
      chatId,
      text: queryMessage.text,
      entities: queryMessage.entities,
      replyToMessageId: messageId,
      // 与上面的 help 同一口径的长期保留例外；理由见
      // formatPermissionQueryMessage 的 JSDoc。目标解析失败、修改拒绝与用法
      // 提示仍走默认 30 秒清理，本例外只覆盖成功渲染出的那张权限看板。
      preserveInGroup: true,
      messageThreadId: forumTopicThreadId(ctx.msg),
    });
    return;
  }

  if (!actorIsSuperAdmin) {
    await sendCommandMessage({
      chatId,
      text: PERMISSION_COMMAND_TEXTS.mutationRejection(
        actor ? formatUserLabel(actor) : "哪个杂鱼"
      ),
      replyToMessageId: messageId,
    });
    return;
  }
  const isEnableAll: boolean =
    tokens.at(-1)?.toLowerCase() === WHITELIST_PERMISSION_ALL_COMMAND;
  if (!isEnableAll && tokens.length < 2) {
    await sendCommandMessage({
      chatId,
      text: PERMISSION_COMMAND_TEXTS.usage,
      replyToMessageId: messageId,
    });
    return;
  }

  let key: WhitelistPermissionKey | undefined;
  let value: boolean | undefined;
  if (!isEnableAll) {
    const rawValue: string = tokens.at(-1)!;
    const rawKey: string = tokens.at(-2)!;
    key = parseWhitelistPermissionKey(rawKey);
    value = parsePermissionBoolean(rawValue);
    if (key === undefined || value === undefined) {
      await sendCommandMessage({
        chatId,
        text: PERMISSION_COMMAND_TEXTS.usageWithKeys(
          WHITELIST_PERMISSION_KEYS.join(", ")
        ),
        replyToMessageId: messageId,
      });
      return;
    }
  }

  const targetArgument: string = tokens
    .slice(0, isEnableAll ? -1 : -2)
    .join(" ");
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    acceptChatId: true,
    messages: PERMISSION_COMMAND_TEXTS.target,
  });
  if (target === undefined) return;
  // 与 /block、/unblock、/white 同一道闸：匿名管理员拿当前群当皮套时
  // resolveCommandTarget 按设计返回这个群自己的 identity（见
  // targetResolution.ts 结尾）。这里必须自己拒绝——给它逐项发权限，等于把
  // /block、/mute 与各功能开关交给这个群的任意匿名管理员，而 Telegram 从不
  // 告诉本进程皮套底下是谁。
  if (target.isChannel === true && target.id === chatId) {
    await sendCommandMessage({
      chatId,
      text: PERMISSION_COMMAND_TEXTS.currentChatTarget,
      replyToMessageId: messageId,
    });
    return;
  }
  // 超级管理员的权限来自身份本身、恒为全开，永远不落进 SQLite 白名单表
  // （见 consts/whitelist.ts 的 SUPER_ADMIN_WHITELIST_PERMISSIONS）。放行只会
  // 写进一条永远不被读到的条目，换过 SUPER_ADMIN_USER_ID 后还会留成全开的旧
  // 身份，所以在入口就挡住。
  if (target.id === SUPER_ADMIN_USER_ID) {
    await sendCommandMessage({
      chatId,
      text: PERMISSION_COMMAND_TEXTS.superAdminTarget,
      replyToMessageId: messageId,
    });
    return;
  }
  if (!isWhitelisted(target.id)) {
    await sendCommandMessage({
      chatId,
      text: PERMISSION_COMMAND_TEXTS.targetNotWhitelisted(formatTargetLabel(target)),
      replyToMessageId: messageId,
    });
    return;
  }

  if (isEnableAll) {
    let result: SetWhitelistPermissionResult;
    try {
      result = enableAllWhitelistPermissions(target.id);
      await confirmWhitelistEntryPersisted(target.id, !result.changed);
    } catch (error: unknown) {
      await reportWhitelistMutationFailure({ chatId, messageId, targetId: target.id, error });
      return;
    }
    const replyText: string = result.changed
      ? PERMISSION_COMMAND_TEXTS.allEnabled(formatTargetLabel(target))
      : PERMISSION_COMMAND_TEXTS.allAlreadyEnabled(formatTargetLabel(target));
    await sendCommandMessage({
      chatId,
      text: replyText,
      replyToMessageId: messageId,
    });
    return;
  }
  if (key === undefined || value === undefined) {
    throw new Error("Permission mutation reached execution without a parsed key and value");
  }

  let result: SetWhitelistPermissionResult;
  try {
    result = setWhitelistPermission({ id: target.id, key, value });
    await confirmWhitelistEntryPersisted(target.id, !result.changed);
  } catch (error: unknown) {
    await reportWhitelistMutationFailure({ chatId, messageId, targetId: target.id, error });
    return;
  }
  await sendCommandMessage({
    chatId,
    text: PERMISSION_COMMAND_TEXTS.permissionSet({
      targetLabel: formatTargetLabel(target),
      key,
      value,
      changed: result.changed,
    }),
    replyToMessageId: messageId,
  });
}
