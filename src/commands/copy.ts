import type { CommandContext, Context } from "grammy";
import type { CachedUser, CopyMode, GlobalCopyState } from "../types/chatState";
import { getChatState, getGlobalCopyState, saveStateInBackground } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, stealAvatarInBackground } from "./copyShared";

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

  // 日语翻译与其它功能开关一致：缺省关闭，只有超级管理员显式 enable 后
  // 才允许启动 /ja_copy。
  if (mode === "ja" && getChatState(chatId).isJATranslationEnabled !== true) {
    await sendMessage(chatId, `本天才在这个群的日语翻译功能被关掉啦，杂鱼去找超级管理员 /ja_copy enable 一下吧♡`, messageId);
    return;
  }

  const cooldownClaim = await claimCopyCooldownOrReject(ctx.from, chatId, messageId);
  if (cooldownClaim.rejected) return;

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, "/copy");
  if (!targetUser) {
    releaseCopyCooldownClaim(cooldownClaim);
    return;
  }

  // 已经在复读时不接新目标——全局同一时间只能复制一个人（不管是从哪个群
  // 发起的），重复点同一个目标和想换人分别嘲讽。
  if (globalCopy.copiedUser !== null) {
    releaseCopyCooldownClaim(cooldownClaim);
    const replyText: string = globalCopy.copiedUser.id === targetUser.id
      ? `早就在复读 ${formatUserLabel(targetUser)} 啦，杂鱼，是没听清楚吗♡`
      : `本天才手上已经有猎物啦，想换人的话先 /stop_copy 呀，笨蛋♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 开始复制模式（不变量见函数顶部 JSDoc）。
  globalCopy.copiedUser = targetUser;
  globalCopy.copyMode = mode;
  globalCopy.copyChatId = chatId;
  // 落盘不阻塞回消息：命令热路径不必等 saveState 的双 fsync 完成（性能项
  // M-6）。上面对 globalCopy 的同步写入已经立即生效，落盘只是让它在下次
  // 重启后依然存在，不影响本次调用后续的复读判定。
  saveStateInBackground("copy started");

  // 发送过渡反馈
  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendMessage(chatId, startText, messageId);

  // 头像复制放在后台执行：copiedUser 已经写入，复读逻辑立即生效。
  stealAvatarInBackground(
    chatId,
    targetUser,
    `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`,
    `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`
  );
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
    await sendMessage(chatId, `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop_copy 什么呀♡`, messageId);
    return;
  }

  globalCopy.copiedUser = null;
  globalCopy.copyMode = undefined;
  globalCopy.copyChatId = undefined;
  saveStateInBackground("copy stopped");

  await sendMessage(chatId, `哼，不玩了，本天才先歇一下~杂鱼♡`, messageId);
}
