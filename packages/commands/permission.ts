import type { MessageEntity } from "@grammyjs/types";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type {
  SetWhitelistPermissionResult,
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/whitelist";
import {
  PERMISSION_COMMAND_TEXTS,
  WHITELIST_PERMISSION_ALL_COMMAND,
  WHITELIST_PERMISSION_HELP,
  WHITELIST_PERMISSION_HELP_COMMAND,
  WHITELIST_PERMISSION_KEYS,
  WHITELIST_PERMISSION_QUERY_COMMAND,
} from "../consts/whitelist";
import {
  enableAllWhitelistPermissions,
  getEffectiveWhitelistPermissions,
  isWhitelisted,
  setWhitelistPermission,
} from "../config/whitelist";
import { SUPER_ADMIN_USER_ID } from "../infra/config";
import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

interface PermissionHelpMessage {
  text: string;
  entities: readonly MessageEntity[];
}

/** 把权限键与说明渲染为可复制的 JSON 代码块，实体偏移按 UTF-16 code unit 计算。 */
function formatPermissionHelpMessage(): PermissionHelpMessage {
  const prefix: string = PERMISSION_COMMAND_TEXTS.helpPrefix;
  const permissionJson: string = JSON.stringify(WHITELIST_PERMISSION_HELP, null, 2);
  return {
    text: `${prefix}${permissionJson}\n${PERMISSION_COMMAND_TEXTS.helpSuffix}`,
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

/** 把发起身份的完整权限渲染为 JSON 代码块；查询回执仍按普通群提示自动删除。 */
function formatPermissionQueryMessage(
  permissions: Readonly<WhitelistPermissions>
): PermissionHelpMessage {
  const prefix: string = PERMISSION_COMMAND_TEXTS.queryPrefix;
  const permissionJson: string = JSON.stringify(permissions, null, 2);
  return {
    text: `${prefix}${permissionJson}`,
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

/** 大小写不敏感地还原为配置中的规范权限键。 */
export function parseWhitelistPermissionKey(
  raw: string
): WhitelistPermissionKey | undefined {
  const normalized: string = raw.toLowerCase();
  return WHITELIST_PERMISSION_KEYS.find(
    (key: WhitelistPermissionKey): boolean => key.toLowerCase() === normalized
  );
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
 * 同一条命令、同一处再抛——`config/` 不可写时一条 /permission 就能把机器人锁进
 * 永久重启循环，所有群一起失能。配置此刻一点没被改动（commitWhitelistMutation
 * 只在写盘成功后才发布运行时快照），因此确认这条 update 是安全的。降级语义与
 * antiRaid/blocklistGuard.ts 的 claimBlockedJoiner 一致。
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
 * 处理 /permission：白名单边界内的身份可查询自身权限与查看说明；仅超级管理员
 * 可修改已经存在的白名单条目。
 *
 * 新增/删除成员由同样仅限超级管理员的 /white 负责；本命令只修改已有身份的
 * 单项或全部权限，避免误发一条带陌生 ID 的消息就扩大整个白名单安全边界。
 *
 * 超级管理员在这条命令里出现在两个位置，语义相反：作为**发起人**他是唯一能改
 * 权限的人；作为**目标**则一律被拒——他的权限来自身份、恒为全开，写进配置文件
 * 的条目永远不会被读到（见 config/whitelist.ts 的 getEffectiveWhitelistPermissions）。
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
    tokens.length === 1 &&
    tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_QUERY_COMMAND;

  if (isHelp || isQuery) {
    // 超级管理员由身份直接持有全部权限，getEffectiveWhitelistPermissions 会
    // 替他补上全开视图，这里不必再单独判身份（见 config/whitelist.ts）。
    const actorPermissions: Readonly<WhitelistPermissions> | undefined =
      actor === undefined ? undefined : getEffectiveWhitelistPermissions(actor.id);
    if (actorPermissions === undefined) {
      await sendCommandMessage({
        chatId,
        text: PERMISSION_COMMAND_TEXTS.outsiderRejection(
          actor ? formatUserLabel(actor) : "哪个杂鱼"
        ),
        replyToMessageId: messageId,
      });
      return;
    }
    if (isHelp) {
      const helpMessage: PermissionHelpMessage = formatPermissionHelpMessage();
      await sendCommandMessage({
        chatId,
        text: helpMessage.text,
        entities: helpMessage.entities,
        replyToMessageId: messageId,
        preserveInGroup: true,
      });
      return;
    }
    const queryMessage: PermissionHelpMessage =
      formatPermissionQueryMessage(actorPermissions);
    await sendCommandMessage({
      chatId,
      text: queryMessage.text,
      entities: queryMessage.entities,
      replyToMessageId: messageId,
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
  // 超级管理员的权限来自身份本身、恒为全开，永远不落进 config/whitelist.json
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
      result = await enableAllWhitelistPermissions(target.id);
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
    result = await setWhitelistPermission({ id: target.id, key, value });
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
