import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState } from "../types";
import { getOrCreateChatState, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim, resolveCopyCommandTarget, stealAvatarInBackground } from "./copyShared";

/**
 * 处理 /copy、/r_copy、/nya_copy 和 /ja_copy 指令。目标既可以通过 @username
 * 参数指定（要求机器人此前已从某条消息中缓存过该用户），也可以（优先）通过回复
 * 目标的一条消息来指定——这种方式对没有公开 username、或机器人从未直接观察到的
 * 用户同样有效。
 * @param mode 对目标纯文本消息应用的文本变换："reverse" 将其反过来念，
 * "nya" 追加 喵~，"ja" 翻译成日语，undefined 表示原样转发。
 */
export async function handleCopyCommand(
  ctx: CommandContext<Context>,
  users: Record<string, CachedUser>,
  chatStates: Map<number, ChatState>,
  globalCopyState: GlobalCopyState,
  mode?: CopyMode
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;
  const state: ChatState = getOrCreateChatState(chatStates, chatId);

  const cooldownClaim = await claimCopyCooldownOrReject(globalCopyState, fromUser, chatId, messageId);
  if (cooldownClaim.rejected) return;

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, users, "/copy");
  if (!targetUser) {
    releaseCopyCooldownClaim(globalCopyState, cooldownClaim);
    return;
  }

  // 已经在复读时不接新目标——保证"同一时间只能复制一个人"，重复点同一个
  // 目标和想换人分别嘲讽。
  if (state.copiedUser !== null) {
    releaseCopyCooldownClaim(globalCopyState, cooldownClaim);
    const replyText: string = state.copiedUser.id === targetUser.id
      ? `早就在复读 ${formatUserLabel(targetUser)} 啦，杂鱼，是没听清楚吗♡`
      : `本天才手上已经有猎物啦，想换人的话先 /stop_copy 呀，笨蛋♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 开始进行复制模式
  state.copiedUser = targetUser;
  state.copyMode = mode;
  // 全局冷却时钟已经在 claimCopyCooldownOrReject 里原子占用，这里跟 chatStates
  // 一起落盘即可——两者存在同一个 state.json 里，一次写入两份都保存。
  await saveState(chatStates, globalCopyState);

  // 发送过渡反馈
  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendMessage(chatId, startText, messageId);

  // 头像复制放在后台执行：state.copiedUser 已经写入，复读逻辑立即生效。
  stealAvatarInBackground(
    chatId,
    targetUser,
    `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`,
    `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`
  );
}

/**
 * 处理 /stop_copy 指令。globalCopyState 本身在这里不变，只是 saveState 要求
 * chatStates 和它一起传（同一个 state.json，一次写入两部分都保存，不能只传
 * 半份把另一半覆盖丢）。
 */
export async function handleStopCommand(
  ctx: CommandContext<Context>,
  chatStates: Map<number, ChatState>,
  globalCopyState: GlobalCopyState
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatStates, chatId);

  if (!state.copiedUser) {
    await sendMessage(chatId, `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop_copy 什么呀♡`, messageId);
    return;
  }

  state.copiedUser = null;
  state.copyMode = undefined;
  await saveState(chatStates, globalCopyState);

  await sendMessage(chatId, `哼，不玩了，本天才先歇一下~杂鱼♡`, messageId);
}
