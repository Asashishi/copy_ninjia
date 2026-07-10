import type { CommandContext, Context } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import type { BotState, CachedUser, CopyMode } from "./types";
import { saveState, saveUsersFile } from "./storage";
import { sendMessage, copyMessage, setReaction, copyUserProfilePhoto, kickChatMember, deleteMessageAfter, KICK_NOTICE_AUTO_DELETE_MS } from "./telegram";
import { applyCopyModeTransform, describeCopyModeEffect } from "./copyModes";
import { formatUserLabel } from "./userLabel";
import { handleGroupJoinVerification } from "./joinVerification";
import { PRIVILEGED_USER_ID } from "./config";

/**
 * 解析出一条消息发送者的 CachedUser 形态身份：可能是真实 Telegram 用户
 * （`from`），也可能是通过 `sender_chat` 或纯粹的 `channel_post`（这种情况下
 * 没有 `sender_chat`，帖子自身的 `chat` 就是该频道）体现的频道身份。既用于
 * 填充 username 缓存，也用于直接从被回复的消息中解析出 /copy 目标。
 */
function resolveSenderIdentity(message: any): CachedUser | undefined {
  const fromUser: any = message.from;
  const senderChat: any = message.sender_chat || (message.chat.type === "channel" ? message.chat : undefined);

  if (senderChat) {
    return {
      id: senderChat.id,
      username: senderChat.username,
      title: senderChat.title,
      isChannel: true,
    };
  } else if (fromUser) {
    return {
      id: fromUser.id,
      username: fromUser.username,
      first_name: fromUser.first_name,
      last_name: fromUser.last_name,
    };
  }

  return undefined;
}

/**
 * 记录/刷新某个发送者的缓存条目（真实 Telegram 用户，或通过 sender_chat /
 * channel_post 体现的频道身份），以便之后 /copy @username 能找到 TA。没有公开
 * username 的发送者不会被缓存在这里（该 map 以 username 为键），但仍可以通过
 * resolveReplyTarget 被定位为目标。
 * @returns 解析出的发送者 id（若以频道身份发送则为频道 id，否则为用户 id）。
 */
export function cacheSender(message: any, users: Record<string, CachedUser>): number | undefined {
  const identity = resolveSenderIdentity(message);
  if (!identity) return undefined;

  if (identity.username) {
    const lowerUsername: string = identity.username.toLowerCase();
    const cached = users[lowerUsername];
    const isStale = !cached ||
      cached.id !== identity.id ||
      cached.title !== identity.title ||
      cached.first_name !== identity.first_name ||
      cached.last_name !== identity.last_name;
    if (isStale) {
      users[lowerUsername] = identity;
    }
  }

  return identity.id;
}

/**
 * 从 /copy 指令所回复的消息中解析出目标，这样即使对方没有公开 @username（或者
 * 机器人还没缓存过 TA，比如因为 privacy mode 屏蔽了 TA 之前的消息），只要能回复到
 * TA 的一条消息，依然可以将其设为目标。
 */
export function resolveReplyTarget(message: any): CachedUser | undefined {
  const repliedMessage: any = message.reply_to_message;
  if (!repliedMessage) return undefined;
  return resolveSenderIdentity(repliedMessage);
}

/**
 * 处理每一条收到的 message/channel_post：刷新发送者缓存，如果消息来自当前
 * 正在被复制的目标，则将其复读回同一个聊天。
 */
export async function handleIncomingMessage(
  ctx: Context,
  users: Record<string, CachedUser>,
  state: BotState
): Promise<void> {
  const message: any = ctx.msg;
  if (!message) return;

  // 入群验证：新成员加入提醒、验证口令、以及验证期间消息的追踪都在这里处理；
  // 处理完入群公告本身，或者验证口令刚好通过，就不需要再走后面的复读逻辑了。
  if (await handleGroupJoinVerification(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message, users);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (state.isCopying && state.copiedUserId && senderId === state.copiedUserId) {
    const text: string = message.text || "";
    // 不复读指令消息，防止指令无限解析
    if (!text.startsWith("/")) {
      // 安全校验：只对"纯文本"消息本身做变换（有 text、无 entities、非媒体）；
      // 带格式/链接/@提及的消息一旦被反转或拼接后缀，会破坏 entity 的偏移量，
      // 可能被用来伪造看似正常、实际指向别处的链接/提及，所以这类消息以及
      // 非文本消息一律走原样 copyMessage，不做任何文本变换。
      const isPlainText: boolean =
        typeof message.text === "string" &&
        (!message.entities || message.entities.length === 0);

      const transformed: string | null = isPlainText
        ? await applyCopyModeTransform(message.text, state.copyMode)
        : null;

      if (transformed !== null) {
        // 变换后的文本只当作纯文本发送（sendMessage 不带 parse_mode），不会被
        // Telegram 当作 HTML/Markdown 解析，也就不存在把用户输入拼进富文本
        // 导致的格式/链接注入问题。
        await sendMessage(chatId, transformed);
      } else {
        // 无变换模式、非纯文本消息、或变换本身失败（如翻译出错）都退化为原样转发。
        await copyMessage(chatId, chatId, message.message_id);
      }
    }
  }
}

/**
 * 处理 message_reaction 更新：把复制目标的 emoji 表情回应同步到同一条消息上
 * （如果目标移除了自己的回应，也会跟着清除）。
 * 自定义 emoji / 付费反应不跟着复制——bot 不一定有权限使用同一个自定义表情。
 */
export async function handleReaction(ctx: Context, state: BotState): Promise<void> {
  const reaction = ctx.messageReaction;
  if (!reaction) return;

  const reactorId: number | undefined = reaction.actor_chat ? reaction.actor_chat.id : reaction.user?.id;
  if (!state.isCopying || !state.copiedUserId || reactorId !== state.copiedUserId) return;

  const emojiReactions: ReactionTypeEmoji[] = reaction.new_reaction.filter(
    (r): r is ReactionTypeEmoji => r.type === "emoji"
  );
  await setReaction(reaction.chat.id, reaction.message_id, emojiReactions);
}

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
  state: BotState,
  mode?: CopyMode
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  // 全局共享一份 lastCopyTime 冷却时钟：只要不是白名单用户触发，任何 copy 类
  // 命令（不管是换目标、重复同一个目标，还是回复消息触发）一律先查时间，
  // 不再区分"是不是在换目标"——冷却没到直接拦，比之前只在切换目标时才检查更简单可靠。
  const isExempted: boolean = !!fromUser && fromUser.id === PRIVILEGED_USER_ID;
  if (!isExempted && state.lastCopyTime) {
    const elapsed: number = Date.now() - state.lastCopyTime;
    const cooldown: number = 5 * 60 * 1000; // 5 分钟，单位毫秒
    if (elapsed < cooldown) {
      const remainingMs: number = cooldown - elapsed;
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
    const replyText: string = `本天才手上已经有猎物啦，想换人的话先 /stop 呀，笨蛋♡`;
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
  await saveState(state);

  // 同步更新并保存到 users.json
  await saveUsersFile({
    lastCopyTime: state.lastCopyTime || 0,
    copiedUser: targetUser,
  });

  // 发送过渡反馈
  const targetLabel: string = formatUserLabel(targetUser);
  const startText: string = `正在把 ${targetLabel} 的脸皮扒下来当本天才的头像哦${describeCopyModeEffect(mode)}，杂鱼乖乖等一下~♡`;
  await sendMessage(chatId, startText, messageId);

  // 头像复制放在后台执行，不阻塞主消息处理：state.isCopying 已经写入，
  // 复读逻辑立即生效；即使头像抓取失败或耗时很久，也不会卡住后续消息的复读。
  void (async (): Promise<void> => {
    const photoUpdated: boolean = await copyUserProfilePhoto(targetUser.id, !!targetUser.isChannel);

    let resultText: string = `嘿嘿，${targetLabel} 的脸已经被本天才偷走啦，杂鱼♡`;
    if (!photoUpdated) {
      resultText = `啧，修改头像失败了呢（可能是 TA 没设置公开头像，或者本天才换头像太频繁被限流了）。不过没关系，本天才依然要开始疯狂复读 ${targetLabel} 的消息啦，杂鱼♡`;
    }

    await sendMessage(chatId, resultText);
  })().catch((error: unknown) => {
    console.error("Error in background avatar copy task:", error);
  });
}

/**
 * 处理 /stop 指令。
 */
export async function handleStopCommand(ctx: CommandContext<Context>, state: BotState): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  if (!state.isCopying) {
    await sendMessage(chatId, `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop 什么呀♡`, messageId);
    return;
  }

  state.isCopying = false;
  state.copiedUserId = null;
  state.copiedIsChannel = false;
  state.copyMode = undefined;
  await saveState(state);

  // 同步更新并保存到 users.json，将当前 copiedUser 置为 null
  await saveUsersFile({
    lastCopyTime: state.lastCopyTime || 0,
    copiedUser: null,
  });

  await sendMessage(chatId, `哼，不玩了，本天才先歇一下~杂鱼♡`, messageId);
}

/**
 * 处理 /kick 指令：回复目标的一条消息并发送 /kick，即可将其移出聊天。仅限
 * PRIVILEGED_USER_ID 使用——其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleKickCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || fromUser.id !== PRIVILEGED_USER_ID) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    const replyText: string = `就 ${mockerLabel} 也想 /kick 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  const targetUser: CachedUser | undefined = resolveReplyTarget(ctx.msg as any);
  if (!targetUser) {
    const replyText: string = `笨蛋，要 /kick 人就回复 TA 的一条消息呀，本天才可不会读心术♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  if (targetUser.id === ctx.me.id) {
    const replyText: string = `笨蛋，本天才才不会把自己踢出去呢♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  await kickChatMember(chatId, targetUser.id);

  const targetLabel: string = formatUserLabel(targetUser);
  const noticeMessageId: number | undefined = await sendMessage(chatId, `哼，${targetLabel} 被本天才一脚踢出去啦，杂鱼别想回来了♡`, messageId);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS);
  }
}
