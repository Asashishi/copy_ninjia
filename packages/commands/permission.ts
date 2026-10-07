import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/identityPolicy";
import type { SetWhitelistPermissionResult } from "../infra/identityPolicy/whitelist";
import { explicitReplyTo, forumTopicThreadId } from "../libs/forumTopic";
import { commandArgumentTokens } from "./arguments";
import { WHITELIST_PERMISSION_ALL_COMMAND, WHITELIST_PERMISSION_HELP_COMMAND, WHITELIST_PERMISSION_JSON_INDENT, WHITELIST_PERMISSION_JSON_LANGUAGE, WHITELIST_PERMISSION_KEY_BY_LOWERCASE, WHITELIST_PERMISSION_KEYS, WHITELIST_PERMISSION_QUERY_COMMAND } from "../consts/whitelist";

import {
  enableAllWhitelistPermissions,
  getWhitelistPermissionQueryView,
  isWhitelisted,
  setWhitelistPermission,
} from "../infra/identityPolicy/whitelist";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { MARKDOWN_V2_PARSE_MODE } from "../consts/telegramMarkdown";
import { escapeMarkdownV2, markdownV2Pre } from "../libs/telegramMarkdown";

import { confirmIdentityPolicyPersisted, prefetchIdentityPolicies } from "../infra/identityStorage";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatActorLabel, formatTargetLabel } from "../users/userLabel";
import { resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

/**
 * 把权限键与说明渲染为 MarkdownV2：转义后的开场白、可复制的 JSON 代码块与用法清单。
 * 开场白、用法清单与 JSON 各按所在上下文转义（见 libs/telegramMarkdown.ts）。
 */
function formatPermissionHelpMessage(atmosphere: AtmosphereTexts): string {
  return escapeMarkdownV2(atmosphere.PERMISSION_COMMAND_TEXTS.helpPrefix) +
    markdownV2Pre(atmosphere.WHITELIST_PERMISSION_HELP_JSON, WHITELIST_PERMISSION_JSON_LANGUAGE) +
    escapeMarkdownV2(`\n${atmosphere.PERMISSION_COMMAND_TEXTS.helpSuffix}`);
}

/**
 * 把目标身份的完整权限渲染为 MarkdownV2：转义后的开场白加 JSON 代码块。开场白里的
 * 目标昵称是用户可控内容，随开场白整段转义，不会形成格式或链接。
 *
 * 与 `help` 一样长期保留：这份权限看板属获授权的长期保留例外，调用点显式传
 * `preserveInGroup: true`（见 docs/cn/04-invariants.md）。
 */
function formatPermissionQueryMessage(
  permissions: Readonly<WhitelistPermissions>,
  targetLabel: string,
  atmosphere: AtmosphereTexts
): string {
  return escapeMarkdownV2(atmosphere.PERMISSION_COMMAND_TEXTS.queryPrefix(targetLabel)) +
    markdownV2Pre(JSON.stringify(permissions, null, WHITELIST_PERMISSION_JSON_INDENT), WHITELIST_PERMISSION_JSON_LANGUAGE);
}

/** 大小写不敏感地还原为配置中的规范权限键。 */
export function parseWhitelistPermissionKey(
  raw: string
): WhitelistPermissionKey | undefined {
  const normalized: string = raw.toLowerCase();
  return WHITELIST_PERMISSION_KEY_BY_LOWERCASE.get(normalized);
}

/** 只接受字面量 true/false（大小写不敏感）。 */
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
 * 白名单写盘失败时就地降级：记一行错误日志并回执 mutationFailed，异常不逸出 handler。
 *
 * 失败可能发生在投递、事务 flush 或精确 ACK 边界，最终值都已作为未 ACK revision 留在
 * 主线程 LRU 里，幂等重试与 Worker 重建都会重放；回执只说「没写进硬盘」。降级语义与
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
    text: chatAtmosphere().PERMISSION_COMMAND_TEXTS.mutationFailed,
    replyToMessageId: messageId,
  });
}

/** `/permission help`：长期保留的权限说明看板。 */
async function sendPermissionHelp(ctx: CommandContext<Context>): Promise<void> {
  await sendCommandMessage({
    chatId: ctx.chat.id,
    text: formatPermissionHelpMessage(chatAtmosphere()),
    parseMode: MARKDOWN_V2_PARSE_MODE,
    replyToMessageId: ctx.msgId,
    preserveInGroup: true,
    // 长期保留的看板必须自己带话题，见 SendMessageParams.messageThreadId。
    messageThreadId: forumTopicThreadId(ctx.msg),
  });
}

/** `/permission query [目标]`：查询自身或指定身份的权限，渲染长期保留的权限看板。 */
async function handlePermissionQuery(
  ctx: CommandContext<Context>,
  tokens: readonly string[],
  actor: CachedUser | undefined
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const rawTargetArgument: string = tokens.slice(1).join(" ");
  let target: CachedUser | undefined = actor;
  if (rawTargetArgument.length > 0 || explicitReplyTo(ctx.msg) !== undefined) {
    target = await resolveCommandTarget({
      chatId,
      message: ctx.msg,
      botUserId: ctx.me.id,
      rawArgument: rawTargetArgument,
      acceptUserId: true,
      // 与授权分支同一解析口径：接受负数会话 id。
      acceptChatId: true,
      messages: chatAtmosphere().PERMISSION_COMMAND_TEXTS.target,
    });
  }
  if (target === undefined) return;
  if (!await prefetchIdentityPolicies([target.id])) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().IDENTITY_POLICY_QUERY_UNAVAILABLE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  // 这里只读预热后的主线程 LRU；非白名单身份复用逐项 false 的静态视图，
  // 不为一次查询创建或写入数据库条目。超级管理员则由配置边界返回全开视图。
  const permissions: Readonly<WhitelistPermissions> =
    getWhitelistPermissionQueryView(target.id);
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  await sendCommandMessage({
    chatId,
    text: formatPermissionQueryMessage(permissions, formatTargetLabel(target, atmosphere), atmosphere),
    parseMode: MARKDOWN_V2_PARSE_MODE,
    replyToMessageId: messageId,
    // 与 help 同一口径的长期保留例外；见 formatPermissionQueryMessage 的 JSDoc。
    // 目标解析失败、修改拒绝与用法提示仍走默认自动清理，本例外只覆盖成功渲染
    // 出的权限看板。
    preserveInGroup: true,
    messageThreadId: forumTopicThreadId(ctx.msg),
  });
}

/** 一次权限修改：全部开启，或把某一项设为给定值。 */
type PermissionMutation =
  | { readonly kind: "all" }
  | { readonly kind: "set"; readonly key: WhitelistPermissionKey; readonly value: boolean };

/**
 * 超级管理员修改已在白名单里的身份：`/permission [目标] all` 全部开启，
 * `/permission [目标] <权限名> <true|false>` 设置单项。
 */
async function handlePermissionMutation(
  ctx: CommandContext<Context>,
  tokens: readonly string[]
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const isEnableAll: boolean =
    tokens.at(-1)?.toLowerCase() === WHITELIST_PERMISSION_ALL_COMMAND;
  if (!isEnableAll && tokens.length < 2) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().PERMISSION_COMMAND_TEXTS.usage,
      replyToMessageId: messageId,
    });
    return;
  }

  let mutation: PermissionMutation = { kind: "all" };
  if (!isEnableAll) {
    const key: WhitelistPermissionKey | undefined = parseWhitelistPermissionKey(tokens.at(-2)!);
    const value: boolean | undefined = parsePermissionBoolean(tokens.at(-1)!);
    if (key === undefined || value === undefined) {
      await sendCommandMessage({
        chatId,
        text: chatAtmosphere().PERMISSION_COMMAND_TEXTS.usageWithKeys(
          WHITELIST_PERMISSION_KEYS.join(", ")
        ),
        replyToMessageId: messageId,
      });
      return;
    }
    mutation = { kind: "set", key, value };
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
    // 「目标不在白名单」判定与逐项权限写入都读目标的名单结论。
    requireIdentityPolicies: true,
    // 与 /block、/block disable、/white 同一道闸：目标解析得到当前群自己的 identity
    // （匿名管理员皮套）时，发送 currentChatTargetText 并返回 undefined（见
    // targetResolution.ts 的 currentChatTargetText）。
    currentChatTargetText: chatAtmosphere().PERMISSION_COMMAND_TEXTS.currentChatTarget,
    messages: chatAtmosphere().PERMISSION_COMMAND_TEXTS.target,
  });
  if (target === undefined) return;
  // 超级管理员的权限来自身份本身、恒为全开，不落进 SQLite 白名单表
  // （见 consts/whitelist.ts 的 SUPER_ADMIN_WHITELIST_PERMISSIONS），目标是他时在入口拒绝。
  if (target.id === SUPER_ADMIN_USER_ID) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().PERMISSION_COMMAND_TEXTS.superAdminTarget,
      replyToMessageId: messageId,
    });
    return;
  }
  if (!isWhitelisted(target.id)) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text: atmosphere.PERMISSION_COMMAND_TEXTS.targetNotWhitelisted(formatTargetLabel(target, atmosphere)),
      replyToMessageId: messageId,
    });
    return;
  }

  let result: SetWhitelistPermissionResult;
  try {
    result = mutation.kind === "all"
      ? enableAllWhitelistPermissions(target.id)
      : setWhitelistPermission({ id: target.id, key: mutation.key, value: mutation.value });
    await confirmIdentityPolicyPersisted("whitelist", target.id, !result.changed);
  } catch (error: unknown) {
    await reportWhitelistMutationFailure({ chatId, messageId, targetId: target.id, error });
    return;
  }
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const targetLabel: string = formatTargetLabel(target, atmosphere);
  let replyText: string;
  if (mutation.kind === "all") {
    replyText = result.changed
      ? atmosphere.PERMISSION_COMMAND_TEXTS.allEnabled(targetLabel)
      : atmosphere.PERMISSION_COMMAND_TEXTS.allAlreadyEnabled(targetLabel);
  } else {
    replyText = atmosphere.PERMISSION_COMMAND_TEXTS.permissionSet({
      targetLabel,
      key: mutation.key,
      value: mutation.value,
      changed: result.changed,
    });
  }
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}

/**
 * 处理 /permission：所有身份都可查看说明并查询自身或指定用户的权限；仅超级
 * 管理员可修改已经存在的白名单条目。
 *
 * 新增/删除成员由 /white 负责；其中持有 isCanWhiteOther 的普通成员只能新增
 * 默认权限条目，删除和本命令的逐项授权仍仅限超级管理员。
 *
 * 超级管理员在这条命令里出现在两个位置，语义相反：作为发起人他是唯一能改
 * 权限的人；作为目标则一律被拒（他的权限来自身份、恒为全开，见 whitelist.ts 的
 * getEffectiveWhitelistPermissions）。
 */
export async function handlePermissionCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const tokens: string[] = commandArgumentTokens(ctx.match);
  if (tokens.length === 1 && tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_HELP_COMMAND) {
    await sendPermissionHelp(ctx);
    return;
  }
  if (tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_QUERY_COMMAND) {
    await handlePermissionQuery(ctx, tokens, actor);
    return;
  }
  if (actor?.id !== SUPER_ADMIN_USER_ID) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId: ctx.chat.id,
      text: atmosphere.PERMISSION_COMMAND_TEXTS.mutationRejection(formatActorLabel(actor, atmosphere)),
      replyToMessageId: ctx.msgId,
    });
    return;
  }
  await handlePermissionMutation(ctx, tokens);
}
