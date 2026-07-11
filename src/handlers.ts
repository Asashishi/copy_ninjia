import type { CommandContext, Context } from "grammy";
import type { CachedUser, ChatState, CopyMode, UsersFileSchema } from "./types";
import { getChatState, getOrCreateChatState, saveState, saveUsersFile } from "./storage";
import { sendMessage, copyMessage, copyUserProfilePhoto, banChatMember, banChatSenderChat, deleteMessageAfter, KICK_NOTICE_AUTO_DELETE_MS } from "./telegram";
import { enqueueReaction, type CopyableReaction } from "./reactionQueue";
import { applyCopyModeTransform, describeCopyModeEffect } from "./copyModes";
import { formatUserLabel } from "./userLabel";
import { handleGroupJoinVerification } from "./joinVerification";
import { PRIVILEGED_USERS_ID } from "./config";
import { recordChatMessage, generateAndSendReply, AI_REPLY_PROBABILITY } from "./aiChat";

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
 * 解析一条消息发言人喂给 AI 上下文所需的身份三元组：id + first_name + last_name。
 * 刻意把 id 和名字分开存（而非拼成一个昵称字符串），好让模型按 id 区分同名的人。
 * 频道马甲/频道帖没有 first_name/last_name，退化为用 title 当 firstName。
 */
function resolveSpeaker(message: any): { id: number; firstName: string; lastName: string } {
  const fromUser: any = message.from;
  const senderChat: any = message.sender_chat || (message.chat.type === "channel" ? message.chat : undefined);
  if (senderChat) {
    return { id: senderChat.id, firstName: senderChat.title ?? "某频道", lastName: "" };
  }
  if (fromUser) {
    return { id: fromUser.id, firstName: fromUser.first_name ?? "", lastName: fromUser.last_name ?? "" };
  }
  return { id: 0, firstName: "某杂鱼", lastName: "" };
}

/**
 * 判断一条消息的文本里是否 @ 了机器人自己。走 entities 里的 "mention" 类型
 * （@username 形式），按 offset/length 截出实际文本再跟机器人的 username 比对，
 * 不用简单的字符串 includes——避免把「@somebody_else_bot」这种子串误判成命中。
 */
function isBotMentioned(message: any, botUsername: string | undefined): boolean {
  if (!botUsername || typeof message.text !== "string") return false;
  const entities: any[] | undefined = message.entities;
  if (!entities) return false;
  const target: string = `@${botUsername}`.toLowerCase();
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentionText: string = message.text.substring(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === target) return true;
    }
  }
  return false;
}

/** 没有复读对象时，随机复读一条新消息的概率。 */
const RANDOM_ECHO_PROBABILITY: number = 1 / 100;

/** 随机复读时的模式池：undefined 表示原样复读，其余对应各 /*_copy 的文本变换。 */
const RANDOM_ECHO_MODES: (CopyMode | undefined)[] = [undefined, "reverse", "nya", "ja"];

/**
 * 「说到洗澡就回看看」的触发词：洗澡 / 泡澡（中间可插最多 4 个白名单里的
 * 助词/修饰字，白名单挡「洗刷刷澡堂子见」这类字面撞上的误伤）以及冲凉
 * （繁体沖涼，中间可插「个/個/了」等）。
 */
const BATH_TRIGGER_PATTERN: RegExp = /[洗泡][个個了完一热熱水冷好]{0,4}澡|[冲沖][个個了完一]{0,2}[凉涼]/;

/**
 * 将一条消息复读回它所在的聊天，并按给定模式做文本变换。
 * @param mode 要应用的文本变换（undefined 表示原样复读）。
 */
async function echoMessage(chatId: number, message: any, mode: CopyMode | undefined): Promise<void> {
  const text: string = message.text || "";
  // 不复读指令消息，防止指令无限解析
  if (text.startsWith("/")) return;

  // 安全校验：只对"纯文本"消息本身做变换（有 text、无 entities、非媒体）；
  // 带格式/链接/@提及的消息一旦被反转或拼接后缀，会破坏 entity 的偏移量，
  // 可能被用来伪造看似正常、实际指向别处的链接/提及，所以这类消息以及
  // 非文本消息一律走原样 copyMessage，不做任何文本变换。
  const isPlainText: boolean =
    typeof message.text === "string" &&
    (!message.entities || message.entities.length === 0);

  const transformed: string | null = isPlainText
    ? await applyCopyModeTransform(message.text, mode)
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

/**
 * 判断一条消息是否有可以被 copyMessage 复制的实际内容。随机复读要靠它过滤掉
 * 置顶提示、成员变动之类的服务消息——对这类消息调用 copyMessage 必然报错。
 * （被 /copy 锁定的目标不走这个过滤：TA 的消息本就该尽数复读，个别复制失败
 * 记日志即可。）
 */
function hasCopyableContent(message: any): boolean {
  return !!(
    message.text || message.caption || message.photo || message.sticker ||
    message.animation || message.video || message.video_note || message.audio ||
    message.voice || message.document || message.dice || message.contact ||
    message.location || message.venue || message.poll || message.story
  );
}

/**
 * 处理每一条收到的 message/channel_post：刷新发送者缓存。如果消息来自当前
 * 正在被复制的目标，则将其复读回同一个聊天；如果本群当前没有复制目标，则以
 * RANDOM_ECHO_PROBABILITY 的概率随机挑一种模式复读这条消息（东一榔头西一棒子
 * 地刷存在感）。
 */
export async function handleIncomingMessage(
  ctx: Context,
  users: Record<string, CachedUser>,
  chatStates: Map<number, ChatState>
): Promise<void> {
  const message: any = ctx.msg;
  if (!message) return;

  // 入群验证：新成员加入提醒、验证口令、以及验证期间消息的追踪都在这里处理；
  // 处理完入群公告本身，或者验证口令刚好通过，就不需要再走后面的复读逻辑了。
  if (await handleGroupJoinVerification(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message, users);
  const state: ChatState = getChatState(chatStates, chatId);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (state.isCopying && state.copiedUserId && senderId === state.copiedUserId) {
    await echoMessage(chatId, message, state.copyMode);
    return;
  }

  // AI 相关逻辑仅在「群聊」且「没有复制对象」时进行：私聊消息不触发（机器人在
  // 私聊里没有群聊上下文，也不该在 DM 里自动搭话）；复制期间机器人正忙着复读
  // 目标，既不攒对话缓存也不触发 AI 回复，免得跟复读抢戏。
  const isPrivateChat: boolean = message.chat.type === "private";
  const messageText: string | undefined = typeof message.text === "string" ? message.text : undefined;
  if (!isPrivateChat && !state.isCopying && messageText && !messageText.startsWith("/")) {
    // 把带文本的普通消息滚动记入本群的 AI 对话缓存（Bot API 无法拉历史，只能
    // 边收边攒最近 75 条）。指令消息（/ 开头）已在上面排除。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, messageText);

    // AI 闲聊回复：用户回复机器人、或者消息里 @ 了机器人 → 必回；否则普通发言
    // 按 AI_REPLY_PROBABILITY 概率触发。命中后就不再走下面的洗澡/随机复读，
    // 免得一条消息既被 AI 回又被复读。
    const repliedTo: any = message.reply_to_message;
    const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === ctx.me.id;
    const isMentioned: boolean = isBotMentioned(message, ctx.me.username);
    if (isReplyToBot || isMentioned || Math.random() < AI_REPLY_PROBABILITY) {
      generateAndSendReply(chatId, message.message_id, isReplyToBot ? repliedTo.text : undefined);
      return;
    }
  }

  // 没有复读对象时，有人说到洗澡/泡澡/冲凉就回一句「看看」，简繁体都认。
  // 「洗/泡」和「澡」之间只允许插入白名单里的助词/修饰字（最多 4 个），
  // 覆盖「洗个澡 / 洗個澡 / 洗了个澡 / 洗完澡 / 洗一个热水澡 / 泡个澡」这类
  // 说法，同时挡住「洗刷刷澡堂子见」这种字面撞上的误伤（洗、泡、澡三字
  // 简繁同形，冲凉的繁体是沖涼）。只对短消息（≤15 字）触发，避免长文里
  // 偶然带出也被打扰。
  // 以 / 开头的是指令（未注册的、或发给其他机器人的指令不会被 bot.command
  // 拦截，会落到这里），与 echoMessage 的「不复读指令消息」保持一致，不触发。
  if (!state.isCopying && typeof message.text === "string" && !message.text.startsWith("/") && message.text.length <= 15 && BATH_TRIGGER_PATTERN.test(message.text)) {
    await sendMessage(chatId, "看看", message.message_id);
    return;
  }

  // 没有复读对象时的随机复读。无需担心和其他机器人形成复读循环：Telegram
  // 保证机器人收不到其他机器人发的消息（官方为防止 bot 互相触发死循环的设计），
  // 自己发的消息也不会作为更新推送回来。
  if (!state.isCopying && hasCopyableContent(message) && Math.random() < RANDOM_ECHO_PROBABILITY) {
    const mode: CopyMode | undefined = RANDOM_ECHO_MODES[Math.floor(Math.random() * RANDOM_ECHO_MODES.length)];
    await echoMessage(chatId, message, mode);
  }
}

/**
 * 处理 message_reaction 更新：把复制目标的表情回应（普通 emoji 和自定义
 * emoji 都支持）同步到同一条消息上；目标移除了自己的回应时也会跟着清除。
 * 实际的 setMessageReaction 调用走 reactionQueue（429 重试、同消息合并、
 * 按 chat 隔离限流等待），这里只做过滤和入队，不阻塞更新处理。
 */
export function handleReaction(ctx: Context, chatStates: Map<number, ChatState>): void {
  const reaction = ctx.messageReaction;
  if (!reaction) return;

  const state: ChatState = getChatState(chatStates, reaction.chat.id);
  const reactorId: number | undefined = reaction.actor_chat ? reaction.actor_chat.id : reaction.user?.id;
  if (!state.isCopying || !state.copiedUserId || reactorId !== state.copiedUserId) return;

  // grammY 的 ctx.reactions() 已把 old/new 的差量按类型分组算好（付费反应被
  // 单独归类，而机器人本来也设不了它，天然排除）。机器人没有 Premium，一条
  // 消息只能设 1 个反应；目标（若是 Premium 用户）却可能同时点了 2~3 个：
  // 优先跟随本次新增的那个，没有新增（比如只是取消了其中一个）就退回仍点着
  // 的第一个；全空表示目标清掉了可复制的反应，跟着清除。
  const { emoji, emojiAdded, emojiRemoved, customEmoji, customEmojiAdded, customEmojiRemoved } = ctx.reactions();
  let toApply: CopyableReaction[];
  if (emojiAdded.length > 0) {
    toApply = [{ type: "emoji", emoji: emojiAdded[0]! }];
  } else if (customEmojiAdded.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmojiAdded[0]! }];
  } else if (emoji.length > 0) {
    toApply = [{ type: "emoji", emoji: emoji[0]! }];
  } else if (customEmoji.length > 0) {
    toApply = [{ type: "custom_emoji", custom_emoji_id: customEmoji[0]! }];
  } else if (emojiRemoved.length === 0 && customEmojiRemoved.length === 0) {
    // 这次变化不涉及任何可复制的反应（比如目标只点了个付费反应）：机器人
    // 既没有要设的也没有要清的，不值得为此花一次 API 调用。
    return;
  } else {
    toApply = [];
  }

  enqueueReaction(reaction.chat.id, reaction.message_id, toApply, ctx.update.update_id, reaction.date);
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
    console.error("Error in background avatar copy task:", error);
  });
}

/**
 * 处理 /stop 指令。
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
    await sendMessage(chatId, `本天才现在什么杂鱼都没盯着呢，笨蛋要 /stop 什么呀♡`, messageId);
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

/**
 * 处理 /kick 指令：将目标移出聊天并永久封禁（与入群验证/反刷群的自动踢出
 * 不同——那些踢而不 ban 以防误杀，这里是管理员的手动判断，直接封死）。
 * 目标解析和 /copy 一致：回复目标的一条消息优先，也可以用 /kick @username
 * 指定（要求本机器人此前缓存过该用户）。目标若是频道马甲（sender_chat），
 * 则改走 banChatSenderChat 封掉该频道身份的发言权。仅限 PRIVILEGED_USERS_ID
 * 白名单内的用户使用——其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleKickCommand(ctx: CommandContext<Context>, users: Record<string, CachedUser>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || !PRIVILEGED_USERS_ID.includes(fromUser.id)) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    const replyText: string = `就 ${mockerLabel} 也想 /kick 人？哪来的资格呀，笨蛋，洗洗睡吧♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 回复目标的消息优先于参数里的 @username（理由同 /copy：没有公开 username
  // 或没被缓存过的目标只能靠回复锁定）。
  let targetUser: CachedUser | undefined = resolveReplyTarget(ctx.msg as any);
  let rawUsername: string | undefined;

  if (!targetUser) {
    const usernameMatch = ctx.match.trim().match(/^@?([a-zA-Z0-9_]+)/);
    if (!usernameMatch) {
      const replyText: string = `笨蛋，要么 /kick @username，要么回复 TA 的一条消息再 /kick，本天才可不会读心术♡`;
      await sendMessage(chatId, replyText, messageId);
      return;
    }
    rawUsername = usernameMatch[1]!;
    targetUser = users[rawUsername.toLowerCase()];
  }

  if (!targetUser) {
    const replyText: string = `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /kick 吧♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  if (targetUser.id === ctx.me.id) {
    const replyText: string = `笨蛋，本天才才不会把自己踢出去呢♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  // 频道马甲（sender_chat）没有可 ban 的用户 id，banChatMember 对它必然报错，
  // 要走 banChatSenderChat 封掉这个频道身份在本群的发言权。
  const banned: boolean = targetUser.isChannel
    ? await banChatSenderChat(chatId, targetUser.id)
    : await banChatMember(chatId, targetUser.id);

  const targetLabel: string = formatUserLabel(targetUser);
  if (!banned) {
    const replyText: string = `呜……${targetLabel} 居然踢不动，是本天才没有封禁权限吧？杂鱼管理员快去检查♡`;
    await sendMessage(chatId, replyText, messageId);
    return;
  }

  const noticeMessageId: number | undefined = await sendMessage(chatId, `哼，${targetLabel} 被本天才一脚踢出去还上了黑名单，杂鱼永远别想回来了♡`, messageId);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS);
  }
}
