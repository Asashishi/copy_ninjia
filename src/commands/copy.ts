import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState, CopyMode, UsersFileSchema } from "../types";
import { getOrCreateChatState, saveChatUsersEntry, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { rejectIfOnCopyCooldown, resolveCopyCommandTarget, stealAvatarInBackground } from "./copyShared";

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
  usersFileData: UsersFileSchema,
  mode?: CopyMode
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;
  const state: ChatState = getOrCreateChatState(chatStates, chatId);

  if (await rejectIfOnCopyCooldown(state, fromUser, chatId, messageId)) return;

  const targetUser: CachedUser | undefined = await resolveCopyCommandTarget(ctx, users, "/copy");
  if (!targetUser) return;

  // 已经在复读时不接新目标——保证"同一时间只能复制一个人"，重复点同一个
  // 目标和想换人分别嘲讽。
  if (state.isCopying && state.copiedUserId !== null) {
    const replyText: string = state.copiedUserId === targetUser.id
      ? `早就在复读 ${formatUserLabel(targetUser)} 啦，杂鱼，是没听清楚吗♡`
      : `本天才手上已经有猎物啦，想换人的话先 /stop_copy 呀，笨蛋♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 开始进行复制模式
  state.isCopying = true;
  state.copiedUserId = targetUser.id;
  state.copiedIsChannel = !!targetUser.isChannel;
  state.copyMode = mode;
  state.lastCopiedUserId = targetUser.id;
  state.lastCopyTime = Date.now();
  await saveState(chatStates);

  // 同步更新并保存到 users.json（仅更新本群聊自己的条目，不影响其他群聊）
  await saveChatUsersEntry(usersFileData, chatId, state.lastCopyTime, targetUser);

  // 发送过渡反馈
  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendMessage(chatId, startText, messageId);

  // 头像复制放在后台执行：state.isCopying 已经写入，复读逻辑立即生效。
  stealAvatarInBackground(
    chatId,
    targetUser,
    `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`,
    `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`
  );
}

/**
 * 处理 /stop_copy 指令。
 */
export async function handleStopCommand(
  ctx: CommandContext<Context>,
  chatStates: Map<number, ChatState>,
  usersFileData: UsersFileSchema
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatStates, chatId);

  if (!state.isCopying) {
    await sendMessage(chatId, `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop_copy 什么呀♡`, messageId);
    return;
  }

  state.isCopying = false;
  state.copiedUserId = null;
  state.copiedIsChannel = false;
  state.copyMode = undefined;
  await saveState(chatStates);

  // 同步更新并保存到 users.json（仅更新本群聊自己的条目），将当前 copiedUser 置为 null
  await saveChatUsersEntry(usersFileData, chatId, state.lastCopyTime, null);

  await sendMessage(chatId, `哼，不玩了，本天才先歇一下~杂鱼♡`, messageId);
}
