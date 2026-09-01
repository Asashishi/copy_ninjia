import type { CommandContext, Context } from "grammy";
import type { User } from "grammy/types";
import { logger } from "../infra/logger";
import {
  getOrCreateChatState,
  persistChatState,
} from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { CachedUser, ChatState } from "../types/chatState";
import type { ToggleCommandTexts } from "../types/commands";
import {
  hasCommandPermission,
  isSuperAdminActor,
  resolveCommandActor,
} from "./commandActor";

/**
 * 发起人是否是 SUPER_ADMIN_USER_ID 本人。当前只有 /send 用它：它是唯一以
 * `ctx.from` 而非命令可见发起身份判定的入口——私聊里没有频道马甲，也不该让
 * sender_chat 参与。其余仅超管命令走 isSuperAdminActor（见 commandActor.ts）。
 *
 * 校验不通过时的反应也刻意不收进这里：/send 只能私聊触发，对非本人的探测保持
 * 沉默、不确认这个指令存在（见 commands/send.ts 头注），与群聊指令「照样回嘴，
 * 只是不执行」的风格不同，不能共用同一个「校验+回复」的一体化函数。
 */
export function isSuperAdmin(fromUser: User | undefined): boolean {
  return fromUser?.id === SUPER_ADMIN_USER_ID;
}

/** resolveSuperAdminToggleArg 的入参；只服务本文件那一个函数，不对外导出。 */
interface SuperAdminToggleOptions {
  /** 本命令的文案表，取自 consts/commands.ts。 */
  readonly texts: ToggleCommandTexts;
  /** 省略时仅允许超级管理员；提供时允许拥有该项白名单权限的身份。 */
  readonly permission?: WhitelistPermissionKey;
}

/** toggleReplyText 的入参；只服务本文件那一个函数，不对外导出。 */
interface ToggleReplyTextParams {
  /** 本次命令写入的目标状态。 */
  readonly isEnabled: boolean;
  /** 写入之前这个群的状态，用来识别同状态重复执行。 */
  readonly wasEnabled: boolean;
  /** 本命令的文案表；这里只取四种状态结局那四项。 */
  readonly texts: ToggleCommandTexts;
}

/**
 * 按「目标状态」与「原状态」选出开关命令的回执文案。
 *
 * 判定只看这两个布尔值，不看落盘或运行时清理是否执行过：同状态重复执行仍会
 * 照常落盘并重跑清理（那正是上一次清理失败后最自然的手工重试路径，理由同
 * commands/block.ts 里重复 /block 仍补投落盘），但回执必须如实说它没改变什么。
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
   * 省略表示这个开关没有「开着也永远不会生效」的前提。
   */
  readonly refuseEnable?: (chatId: number, messageId: number | undefined) => Promise<boolean>;
  /** 关闭方向的运行时拆除；省略表示没有需要就地收掉的运行时状态。 */
  readonly teardown?: (chatId: number) => void | Promise<void>;
  /**
   * 拆除失败时的替代回执。省略表示「拆不干净也照常按开关结果回执」——只有
   * 状态活在主线程镜像、会被 Worker 重建 adopt 回去的开关才需要如实告知
   * （当前只有 /antiraid，见该命令头注）。
   */
  readonly teardownFailedText?: string;
}

/**
 * 按群开关命令的统一编排：解析授权与参数 → 开启前的配置总闸 → 写入并落盘 →
 * 关闭方向尽力而为地拆除运行时 → 回执。
 *
 * 四条命令（/ad_detect、/ai_chat、/flood_control、/antiraid）共用这一编排。
 * 其中两处顺序是语义，不能由调用方自由发挥：
 * - 落盘**先于**运行时拆除。反过来的话，拆干净了却没落盘，重启后开关又是开的。
 * - 拆除异常只记日志、绝不外抛。开关本身已经落盘；放它逃出 handler 就是这条
 *   update 判失败、最终 offset 被扣住、重启后 Telegram 重投同一条命令——而
 *   Worker 那时仍不可用，重投同样失败，恰好把重启循环焊死。
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
  teardown,
  teardownFailedText,
}: ChatToggleCommandParams): Promise<void> {
  const arg: "enable" | "disable" | undefined =
    await resolveSuperAdminToggleArg(ctx, { texts, permission });
  if (arg === undefined) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const isEnabled: boolean = arg === "enable";
  if (isEnabled && refuseEnable !== undefined && await refuseEnable(chatId, messageId)) {
    return;
  }

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
 * /ai_chat、/ja_copy（开关分支）、/init、/ad_detect、/flood_control 共用的权限与参数校验。
 *
 * 提供 permission 时按该权限键授权；超级管理员恒持有全部权限键（见
 * whitelist.ts），因此不必也不该在这里再判一次身份。省略 permission 则是
 * 「只认身份、无法授权出去」的一类（当前只有 /init），走 isSuperAdminActor。
 * ctx.match 还必须是 enable/disable 之一。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  { texts, permission }: SuperAdminToggleOptions
): Promise<"enable" | "disable" | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const isAuthorized: boolean = permission === undefined
    ? isSuperAdminActor(ctx)
    : hasCommandPermission(ctx, permission);

  if (!actor || !isAuthorized) {
    await sendCommandMessage({
      chatId,
      text: texts.rejection(actor ? formatUserLabel(actor) : "哪个杂鱼"),
      replyToMessageId: messageId,
    });
    return undefined;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendCommandMessage({ chatId, text: texts.usage, replyToMessageId: messageId });
    return undefined;
  }

  return arg;
}
