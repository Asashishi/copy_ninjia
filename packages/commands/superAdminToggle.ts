import type { CommandContext, Context } from "grammy";
import { logger } from "../infra/logger";
import {
  getOrCreateChatState,
  persistChatState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { CachedUser, ChatState } from "../types/chatState";
import type { ToggleAction, ToggleCommandTexts } from "../types/commands";
import { rejectUnlessPermitted, rejectUnlessSuperAdmin } from "./commandActor";
import { parseToggleAction } from "./arguments";

/** resolveSuperAdminToggleArg 的入参。 */
interface SuperAdminToggleOptions {
  /** 本命令的文案表，取自 consts/commands.ts。 */
  readonly texts: ToggleCommandTexts;
  /** 省略时仅允许超级管理员；提供时允许拥有该项白名单权限的身份。 */
  readonly permission?: WhitelistPermissionKey;
}

/** toggleReplyText 的入参。 */
interface ToggleReplyTextParams {
  /** 本次命令写入的目标状态。 */
  readonly isEnabled: boolean;
  /** 写入之前这个群的状态，用来识别同状态重复执行。 */
  readonly wasEnabled: boolean;
  /** 本命令的文案表；这里只取各状态结局的回执文案。 */
  readonly texts: ToggleCommandTexts;
}

/**
 * 按「目标状态」与「原状态」选出开关命令的回执文案。
 *
 * 判定只看这两个布尔值，不看落盘或运行时清理是否执行过：同状态重复执行仍会
 * 落盘并重跑清理，回执说明状态未改变。
 */
export function toggleReplyText({
  isEnabled,
  wasEnabled,
  texts,
}: ToggleReplyTextParams): string {
  if (isEnabled === wasEnabled) {
    return isEnabled ? texts.alreadyEnabled : texts.alreadyDisabled;
  }
  return isEnabled ? texts.enabled : texts.disabled;
}

/** runChatToggleCommand 的入参；按群开关命令的完整编排都由它描述。 */
export interface ChatToggleCommandParams {
  readonly ctx: CommandContext<Context>;
  /** 本命令的文案表，取自 consts/commands.ts。 */
  readonly texts: ToggleCommandTexts;
  /** 授权用的白名单权限键；超级管理员恒持有全部键。 */
  readonly permission: WhitelistPermissionKey;
  /** 落盘原因串，进 persistChatState。 */
  readonly persistReason: string;
  /** 运行时清理对象的英文名，只进错误日志，例如 `queued ad detection`。 */
  readonly runtimeLabel: string;
  /** 读这个群当前的开关位。 */
  readonly read: (state: ChatState) => boolean;
  /** 写入目标开关位；调用方只改自己那一个字段。 */
  readonly write: (state: ChatState, isEnabled: boolean) => void;
  /**
   * 开启方向的配置总闸；返回 true 表示它已经自己回执并拒绝了本次开启。
   * 省略表示开启时不检查部署配置。
   */
  readonly refuseEnable?: (chatId: number, messageId: number | undefined) => Promise<boolean>;
  /** 关闭开关前必须完成的持久化前置操作；失败原样上抛，不确认本条 update。 */
  readonly beforeDisable?: (chatId: number) => Promise<void>;
  /** 关闭方向的运行时拆除；省略表示没有需要就地收掉的运行时状态。 */
  readonly teardown?: (chatId: number) => void | Promise<void>;
  /**
   * 拆除失败时的替代回执。省略表示拆除失败时仍按开关结果回执；状态活在主线程镜像
   * 的开关（/antiraid，见 commands/antiRaid.ts）提供它。
   */
  readonly teardownFailedText?: string;
}

/**
 * 按群开关命令的统一编排：解析授权与参数 → 配置总闸或关闭前的持久化前置操作 → 写入并落盘 →
 * 关闭方向尽力而为地拆除运行时 → 回执。
 *
 * /ad_detect、/ai_chat、/flood_control、/antiraid 与 /translate 开关共用这一编排。
 * 其中两处顺序是语义，调用方不得改动：
 * - 落盘先于运行时拆除。
 * - 拆除异常只记日志、不外抛；开关此时已落盘。
 */
export async function runChatToggleCommand({
  ctx,
  texts,
  permission,
  persistReason,
  runtimeLabel,
  read,
  write,
  refuseEnable,
  beforeDisable,
  teardown,
  teardownFailedText,
}: ChatToggleCommandParams): Promise<void> {
  const arg: ToggleAction | undefined =
    await resolveSuperAdminToggleArg(ctx, { texts, permission });
  if (arg === undefined) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const isEnabled: boolean = arg === "enable";
  if (isEnabled && refuseEnable !== undefined && await refuseEnable(chatId, messageId)) {
    return;
  }
  if (!isEnabled && beforeDisable !== undefined) await beforeDisable(chatId);

  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = read(state);
  write(state, isEnabled);
  // 落盘失败原样上抛：那是 fatal durability failure，这条 update 不能被确认
  // （见 docs/cn/04-invariants.md）。
  await persistChatState(chatId, persistReason);

  let teardownFailed: boolean = false;
  if (!isEnabled && teardown !== undefined) {
    try {
      await teardown(chatId);
    } catch (error: unknown) {
      teardownFailed = true;
      logger.error(
        `Failed to tear down the ${runtimeLabel} of chat ${chatId}; ` +
        "the switch is already persisted as disabled:",
        error
      );
    }
  }

  const replyText: string = teardownFailed && teardownFailedText !== undefined
    ? teardownFailedText
    : toggleReplyText({ isEnabled, wasEnabled, texts });
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}

/**
 * runChatToggleCommand 的各调用方与 /init 共用的权限与参数校验。
 *
 * 提供 permission 时按该权限键授权，超级管理员恒持有全部权限键（见
 * whitelist.ts）；省略 permission 时只认超级管理员身份（/init），走
 * rejectUnlessSuperAdmin。ctx.match 还必须是 enable/disable 之一，否则回复
 * texts.usage。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  { texts, permission }: SuperAdminToggleOptions
): Promise<ToggleAction | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = permission === undefined
    ? await rejectUnlessSuperAdmin(ctx, texts.rejection)
    : await rejectUnlessPermitted(ctx, permission, texts.rejection);
  if (actor === undefined) return undefined;

  const arg: ToggleAction | undefined = parseToggleAction(ctx.match.trim());
  if (arg === undefined) {
    await sendCommandMessage({ chatId, text: texts.usage, replyToMessageId: messageId });
    return undefined;
  }

  return arg;
}
