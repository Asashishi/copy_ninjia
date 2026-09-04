import type { CommandContext, Context } from "grammy";
import {
  COPY_TARGET_TEXTS,
  JA_COPY_TARGET_TEXTS,
  NYA_COPY_TARGET_TEXTS,
  REVERSE_COPY_TARGET_TEXTS,
} from "../consts/commands";
import type { CachedUser, CopyMode, GlobalCopyState } from "../types/chatState";
import type { CommandTargetMessages } from "../types/commands";
import { getChatState, getGlobalCopyState, persistGlobalState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { isJaTranslationConfigured } from "../copy/availability";
import { describeCopyModeEffect } from "../copy/copyModes";
import { jaTranslateConfigReadiness } from "../config/readiness";
import { refuseIfConfigBroken } from "./configGate";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, restoreAvatarInBackground, stealAvatarInBackground } from "./copyShared";
import { peekCommandTarget } from "./targetResolution";
import { resolveCommandActor } from "./commandActor";

/** 按实际入口选取目标提示，避免各 copy 模式报错时都误念成 `/copy`。 */
function copyTargetTextsForMode(mode: CopyMode | undefined): Readonly<CommandTargetMessages> {
  if (mode === "reverse") return REVERSE_COPY_TARGET_TEXTS;
  if (mode === "nya") return NYA_COPY_TARGET_TEXTS;
  if (mode === "ja") return JA_COPY_TARGET_TEXTS;
  return COPY_TARGET_TEXTS;
}

/**
 * 处理 /copy、/r_copy、/nya_copy 和 /ja_copy 指令。目标既可以通过 @username
 * 参数指定（要求机器人此前已从某条消息中缓存过该用户），也可以（优先）通过回复
 * 目标的一条消息来指定——这种方式对没有公开 username、或机器人从未直接观察到的
 * 用户同样有效。
 *
 * 复读目标是全局唯一的（机器人只有一张脸，同一时刻只能"变成"一个人）：
 * 任何群在复读时，其他群想 /copy 都会被挡，得先 /stop_copy（任何群都能停）。
 * 复读行为本身只发生在发起 /copy 的这个群里。
 * @param mode 对目标纯文本消息应用的文本变换："reverse" 将其反过来念，
 * "nya" 追加 喵~，"ja" 翻译成日语，undefined 表示原样转发。
 */
export async function handleCopyCommand(
  ctx: CommandContext<Context>,
  mode?: CopyMode
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const globalCopy: GlobalCopyState = getGlobalCopyState();

  // 日语翻译与其它功能开关一致：缺省关闭，要先由持有
  // isCanControllJATranslatePermission 的身份（超级管理员恒持有）显式
  // /ja_copy enable 才允许启动。两道前提分开报——「本群没开」要找拿得到这项
  // 权限的人，「密钥坏了」要改文件加重启，混成一句只会让人去敲一条不解决问题
  // 的命令。
  if (mode === "ja") {
    // 密钥不可用时不能放行：翻译失败的降级是静默的（原样发出未翻译的原文），
    // 群里看不出与「翻译服务抖了一下」的区别，见 copy/availability.ts。
    if (!isJaTranslationConfigured()) {
      await refuseIfConfigBroken({
        readiness: jaTranslateConfigReadiness(),
        chatId,
        messageId,
        feature: "Japanese translation",
        text: (file: string): string => `本天才的 ${file} 不见了或写坏了，翻不了日语呀。补好再重启，笨蛋♡`,
      });
      return;
    }
    if (getChatState(chatId).isJATranslationEnabled !== true) {
      await sendCommandMessage({
        chatId,
        text: `本天才在这个群的日语翻译功能被关掉啦，杂鱼去找超级管理员 /ja_copy enable 一下吧♡`,
        replyToMessageId: messageId,
      });
      return;
    }
  }

  // acknowledged runner 严格串行处理 update；本次命令返回前不会开始另一条命令。
  if (globalCopy.copiedUser !== null) {
    // 这条 /copy 已经注定被拒，这里只想知道目标是谁好挑一句文案——必须用不带
    // 发送副作用的只读查询。走完整解析的话，参数是未缓存的 @username 时它会
    // 自己发一条「@x 都还没说过话呢」并返回 undefined，用户收到的是「不认识
    // 这个用户名」，而真正的原因（正在复读别人）永远没说。
    const targetUser: CachedUser | undefined = peekCommandTarget(ctx.msg, ctx.match);
    const replyText: string = globalCopy.copiedUser.id === targetUser?.id
      ? `早就在复读 ${formatUserLabel(targetUser)} 啦，杂鱼，是没听清楚吗♡`
      : `本天才手上已经有猎物啦，想换人的话先 /stop_copy 呀，笨蛋♡`;
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  let cooldownClaim: Awaited<ReturnType<typeof claimCopyCooldownOrReject>> | undefined;
  let copyStarted: boolean = false;
  let targetUser: CachedUser | undefined;
  try {
    cooldownClaim = await claimCopyCooldownOrReject(resolveCommandActor(ctx), chatId, messageId);
    if (cooldownClaim.rejected) return;

    targetUser = await resolveCopyCommandTarget(ctx, copyTargetTextsForMode(mode));
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

  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendCommandMessage({ chatId, text: startText, replyToMessageId: messageId });

  // 头像复制放在后台执行：copiedUser 已经写入，复读逻辑立即生效。
  stealAvatarInBackground({
    chatId,
    target: targetUser,
    successText: `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`,
    failureText: `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`,
  });
}

/**
 * 处理 /stop_copy 指令。复读目标是全局的，在任何群都可以停——不限于当初
 * 发起 /copy 的那个群。
 */
export async function handleStopCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const globalCopy: GlobalCopyState = getGlobalCopyState();

  if (!globalCopy.copiedUser) {
    await sendCommandMessage({
      chatId,
      text: `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop_copy 什么呀♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  globalCopy.copiedUser = null;
  globalCopy.copyMode = undefined;
  globalCopy.copyChatId = undefined;
  await persistGlobalState("copy stopped");

  await sendCommandMessage({ chatId, text: `哼，不玩了，本天才先歇一下~杂鱼♡`, replyToMessageId: messageId });

  // 停止复读顺带把脸换回来：/copy 会偷目标头像，只停复读不复原会留下一张
  // 「已经不复读了、却还顶着别人脸」的机器人。
  //
  // 这一步刻意**不占**全局冷却：/stop_copy 必须任何时候都能停下来，被冷却挡住
  // 就成了「停不掉」。绕开限流的风险也有限——真正会触发换头像的是 /copy 与
  // /steal_icon，它们各自都被同一个冷却闸门住；而上面的活动状态门禁保证
  // 每次复原背后都对应着一次已经过闸的 /copy，复原节奏因此仍受其约束。
  restoreAvatarInBackground({
    chatId,
    successText: `顺手把脸也换回来了，本天才的原装脸可比杂鱼们的耐看多了♡`,
    failureText: `复读是停了，但脸没换回来呢（图取不下来或者被限流了），等下可以 /reset_icon 再试，杂鱼♡`,
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
