import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";

import { COPY_SUBCOMMAND_PATTERN } from "../consts/copyModes";

import type { CachedUser, CopyMode, GlobalCopyState } from "../types/chatState";
import type { CommandTargetMessages } from "../types/commands";
import { getGlobalCopyState, persistGlobalState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, restoreAvatarInBackground, stealAvatarInBackground } from "./copyShared";
import { peekCommandTarget } from "./targetResolution";
import { resolveCommandActor } from "./commandActor";

/** 按复读模式选取包含对应 /copy 参数的目标提示。 */
function copyTargetTextsForMode(mode: CopyMode | undefined, atmosphere: AtmosphereTexts): Readonly<CommandTargetMessages> {
  if (mode === "reverse") return atmosphere.REVERSE_COPY_TARGET_TEXTS;
  if (mode === "nya") return atmosphere.NYA_COPY_TARGET_TEXTS;
  return atmosphere.COPY_TARGET_TEXTS;
}

/**
 * 处理 /copy [reverse|nya] [@username] 与 /copy stop。目标既可以通过 @username
 * 参数指定（要求机器人此前已从某条消息中缓存过该用户），也可以（优先）通过回复
 * 目标的一条消息来指定——这种方式对没有公开 username、或机器人从未直接观察到的
 * 用户同样有效。
 *
 * 复读目标是全局唯一的（机器人只有一张脸，同一时刻只能"变成"一个人）：
 * 任何群在复读时，其他群想 /copy 都会被挡，得先 /copy stop（任何群都能停）。
 * 复读行为本身只发生在发起 /copy 的这个群里。
 */
export async function handleCopyCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const argument: string = ctx.match.trim();
  const match: RegExpExecArray | null = COPY_SUBCOMMAND_PATTERN.exec(argument);
  const subcommand: string | undefined = match?.[1];
  if (subcommand === "stop") {
    if (match?.[2] !== undefined) {
      await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).COPY_USAGE_TEXT, replyToMessageId: messageId });
      return;
    }
    await stopCopy(ctx);
    return;
  }
  const mode: CopyMode | undefined = subcommand === "reverse" || subcommand === "nya"
    ? subcommand
    : undefined;
  const targetArgument: string = mode === undefined ? argument : match?.[2] ?? "";
  const globalCopy: GlobalCopyState = getGlobalCopyState();

  // acknowledged runner 严格串行处理 update；本次命令返回前不会开始另一条命令。
  if (globalCopy.copiedUser !== null) {
    // 这条 /copy 已经注定被拒，这里只想知道目标是谁好挑一句文案——必须用不带
    // 发送副作用的只读查询。走完整解析的话，参数是未缓存的 @username 时它会
    // 自己发一条「@x 都还没说过话呢」并返回 undefined，用户收到的是「不认识
    // 这个用户名」，而真正的原因（正在复读别人）永远没说。
    const targetUser: CachedUser | undefined = peekCommandTarget(ctx.msg, targetArgument);
    const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
    const replyText: string = globalCopy.copiedUser.id === targetUser?.id
      ? atmosphere.NOTICE_TEXTS.copyAlreadyRunning(formatUserLabel(targetUser, atmosphere))
      : atmosphere.NOTICE_TEXTS.copyOtherTarget;
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  let cooldownClaim: Awaited<ReturnType<typeof claimCopyCooldownOrReject>> | undefined;
  let copyStarted: boolean = false;
  let targetUser: CachedUser | undefined;
  try {
    cooldownClaim = await claimCopyCooldownOrReject(resolveCommandActor(ctx), chatId, messageId);
    if (cooldownClaim.rejected) return;

    targetUser = await resolveCopyCommandTarget(ctx, copyTargetTextsForMode(mode, chatAtmosphere(chatId)), targetArgument);
    if (!targetUser) return;

    globalCopy.copiedUser = targetUser;
    globalCopy.copyMode = mode;
    globalCopy.copyChatId = chatId;
    copyStarted = true;
  } finally {
    if (!copyStarted && cooldownClaim && !cooldownClaim.rejected) {
      await releaseCopyCooldownClaim(cooldownClaim);
    }
  }

  if (!targetUser) return;
  // 成功反馈和头像任务必须等对应 revision 的主、备两份 state 都 durable，
  // 避免 update 已确认后重启复活旧 copy 状态。
  await persistGlobalState("copy started");

  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const targetLabel: string = formatUserLabel(targetUser, atmosphere);
  const startText: string = atmosphere.NOTICE_TEXTS.copyStarting(targetLabel, describeCopyModeEffect(mode, atmosphere));
  await sendCommandMessage({ chatId, text: startText, replyToMessageId: messageId });

  // 头像复制放在后台执行：copiedUser 已经写入，复读逻辑立即生效。
  stealAvatarInBackground({
    chatId,
    target: targetUser,
    source: "copy",
  });
}

/**
 * 处理 /copy stop。复读目标是全局的，在任何群都可以停——不限于当初
 * 发起 /copy 的那个群。
 */
async function stopCopy(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const globalCopy: GlobalCopyState = getGlobalCopyState();

  if (!globalCopy.copiedUser) {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere(chatId).NOTICE_TEXTS.copyNotRunning,
      replyToMessageId: messageId,
    });
    return;
  }

  globalCopy.copiedUser = null;
  globalCopy.copyMode = undefined;
  globalCopy.copyChatId = undefined;
  await persistGlobalState("copy stopped");

  await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).NOTICE_TEXTS.copyStopped, replyToMessageId: messageId });

  // /copy stop 不占全局冷却；仅在停止活动复读后预约恢复默认头像。
  restoreAvatarInBackground({
    chatId,
    source: "copy",
  });
}

/** teardown 专用：只停止由指定源群持有的全局 copy，不在这里单独落盘。 */
function stopCopyOwnedByChat(chatId: number): boolean {
  const globalCopy: GlobalCopyState = getGlobalCopyState();
  if (globalCopy.copiedUser === null || globalCopy.copyChatId !== chatId) return false;
  globalCopy.copiedUser = null;
  globalCopy.copyMode = undefined;
  globalCopy.copyChatId = undefined;
  return true;
}

registerChatTeardown("copy", (chatId: number): void => { stopCopyOwnedByChat(chatId); });
