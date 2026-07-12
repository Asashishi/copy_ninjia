import { logger } from "../logger";
import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState, CopyMode, UsersFileSchema } from "../types";
import { getOrCreateChatState, saveState, saveUsersFile } from "../infra/storage";
import { sendMessage, copyUserProfilePhoto } from "../infra/telegram";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { resolveReplyTarget } from "../users/senderIdentity";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import { COPY_COOLDOWN_MS } from "../consts/commands";

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

  // 全局共享一份 lastCopyTime 冷却时钟：只要不是白名单用户触发，任何 copy 类
  // 命令（不管是换目标、重复同一个目标，还是回复消息触发）一律先查时间，
  // 不再区分"是不是在换目标"——冷却没到直接拦，比之前只在切换目标时才检查更简单可靠。
  const isExempted: boolean = !!fromUser && PRIVILEGED_USERS_ID.includes(fromUser.id);
  if (!isExempted && state.lastCopyTime) {
    const elapsed: number = Date.now() - state.lastCopyTime;
    if (elapsed < COPY_COOLDOWN_MS) {
      const remainingMs: number = COPY_COOLDOWN_MS - elapsed;
      const remainingMinutes: number = Math.floor(remainingMs / 60000);
      const remainingSeconds: number = Math.ceil((remainingMs % 60000) / 1000);
      const timeStr: string = remainingMinutes > 0
        ? `${remainingMinutes} 分 ${remainingSeconds} 秒`
        : `${remainingSeconds} 秒`;
      const replyText: string = `急什么呀笨蛋，还要等 ${timeStr} 才能用 copy 类命令哦，乖乖等着吧♡`;
      await sendMessage(chatId, replyText, messageId);
      return;
    }
  }

  // 回复目标的消息来 /copy 优先于参数里的 @username：这样即使对方没有公开
  // username、或者本天才还没缓存过 TA（比如 privacy mode 没关导致漏听），
  // 只要能回复到 TA 发的一条消息就能直接锁定目标。
  const replyTarget: CachedUser | undefined = resolveReplyTarget(ctx.msg as any);

  let targetUser: CachedUser | undefined = replyTarget;
  let rawUsername: string | undefined;

  if (!targetUser) {
    const usernameMatch = ctx.match.trim().match(/^@?([a-zA-Z0-9_]+)/);
    if (!usernameMatch) {
      const replyText: string = `笨蛋，要么 /copy @username，要么直接回复 TA 的一条消息再 /copy，本天才总得知道杂鱼是谁吧♡`;
      await sendMessage(chatId, replyText, messageId);
      return;
    }
    rawUsername = usernameMatch[1]!;
    targetUser = users[rawUsername.toLowerCase()];
  }

  if (!targetUser) {
    const replyText: string = `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 /copy 呀♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 不能把本天才自己设成复制目标，否则复读会自己套自己没完没了
  if (targetUser.id === ctx.me.id) {
    const replyText: string = `笨蛋，本天才怎么可能盯上自己呀♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 检查是否已经在复制这个目标——保证"同一时间只能复制一个人"
  if (state.isCopying && state.copiedUserId !== null) {
    if (state.copiedUserId === targetUser.id) {
      const replyText: string = `早就在复读 ${formatUserLabel(targetUser)} 啦，杂鱼，是没听清楚吗♡`;
      await sendMessage(chatId, replyText, messageId);
      return;
    }
  }

  // 检查是否已经在复制另一个目标，避免同时复制多人
  if (state.isCopying && state.copiedUserId !== null) {
    const replyText: string = `本天才手上已经有猎物啦，想换人的话先 /stop_copy 呀，笨蛋♡`;
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
  usersFileData[String(chatId)] = {
    lastCopyTime: state.lastCopyTime || 0,
    copiedUser: targetUser,
  };
  await saveUsersFile(usersFileData);

  // 发送过渡反馈
  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendMessage(chatId, startText, messageId);

  // 头像复制放在后台执行，不阻塞主消息处理：state.isCopying 已经写入，
  // 复读逻辑立即生效；即使头像抓取失败或耗时很久，也不会卡住后续消息的复读。
  void (async (): Promise<void> => {
    const photoUpdated: boolean = await copyUserProfilePhoto(targetUser.id, !!targetUser.isChannel, targetUser.username);

    let resultText: string = `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`;
    if (!photoUpdated) {
      resultText = `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`;
    }

    await sendMessage(chatId, resultText);
  })().catch((error: unknown) => {
    logger.error("Error in background avatar copy task:", error);
  });
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
  usersFileData[String(chatId)] = {
    lastCopyTime: state.lastCopyTime || 0,
    copiedUser: null,
  };
  await saveUsersFile(usersFileData);

  await sendMessage(chatId, `哼，不玩了，本天才先歇一下~杂鱼♡`, messageId);
}
