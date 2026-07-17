import type { Context } from "grammy";
import type { Animation, Message, PhotoSize } from "@grammyjs/types";
import type { ChatState, CopyMode } from "../types";
import { getActiveCopyIn, getChatState, saveState } from "../infra/storage";
import { sendMessage, copyMessage } from "../infra/telegram";
import { recordChatTitleFromChat } from "../infra/chatTitle";
import { applyCopyModeTransform } from "../copy/copyModes";
import { cacheSender } from "../users/senderIdentity";
import { recordChatMessage, recordChatMedia, generateAndSendReply } from "../aiChat";
import { AI_REPLY_PROBABILITY, MEDIA_MAX_DOWNLOAD_BYTES } from "../consts/aiChat";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  BATH_TRIGGER_REPLY_TEXT,
  FALLBACK_CHANNEL_NAME,
  FALLBACK_SPEAKER_NAME,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
  USER_RANDOM_REPLY_COOLDOWN_MS,
} from "../consts/auto";
import { userRandomReplyTimes } from "../cache/auto";
import { describeStickerForContext, pickStickerVisionSource } from "../ai/stickerSets";
import { pickRandom } from "../libs/random";
import { isSelfSent } from "../infra/selfSentTracker";

/**
 * 消息自动流水线：复制目标的复读、AI 对话缓存与触发、洗澡「看看」、随机
 * 复读。与 src/commands 下的显式命令不同，这里的行为都是机器人自己看时机
 * 触发的。（入群守卫的事件投递不在这里——它以中间件形式挂在 index.ts 的
 * 命令处理器之前，否则命令消息会漏追踪；入群公告也在那里就被吞掉，到不了
 * 本流水线。）
 */

/**
 * 尝试为某个发言人占用一次「AI 随机回复」的名额：若 TA 仍在冷却期内则返回
 * false；否则记录本次触发时刻并返回 true。冷却按「群 × 用户」独立计算——
 * key 里拼了 chatId，同一个人在 A 群触发过不影响 TA 在 B 群被随机回复。
 * key 只用 id、不掺昵称：昵称随时可改，掺进去改个名就能重置冷却。
 * 记录会在冷却期满后自动从 Map 中清理（仅当期间没有更新的记录覆盖它），
 * 避免长期运行下的内存泄漏。
 */
function tryClaimUserRandomReply(chatId: number, speakerId: number): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const now: number = Date.now();
  const lastTime: number = userRandomReplyTimes.get(key) ?? 0;
  if (now - lastTime < USER_RANDOM_REPLY_COOLDOWN_MS) return false;

  userRandomReplyTimes.set(key, now);
  setTimeout(() => {
    if (userRandomReplyTimes.get(key) === now) {
      userRandomReplyTimes.delete(key);
    }
  }, USER_RANDOM_REPLY_COOLDOWN_MS).unref();
  return true;
}

/**
 * 解析一条消息发言人喂给 AI 上下文所需的身份三元组：id + first_name + last_name。
 * 刻意把 id 和名字分开存（而非拼成一个昵称字符串），好让模型按 id 区分同名的人。
 * 频道马甲/频道帖没有 first_name/last_name，退化为用 title 当 firstName。
 */
function resolveSpeaker(message: Message): { id: number; firstName: string; lastName: string } {
  const fromUser = message.from;
  const senderChat = message.sender_chat ?? (message.chat.type === "channel" ? message.chat : undefined);
  if (senderChat) {
    return { id: senderChat.id, firstName: ("title" in senderChat ? senderChat.title : undefined) ?? FALLBACK_CHANNEL_NAME, lastName: "" };
  }
  if (fromUser) {
    return { id: fromUser.id, firstName: fromUser.first_name ?? "", lastName: fromUser.last_name ?? "" };
  }
  return { id: 0, firstName: FALLBACK_SPEAKER_NAME, lastName: "" };
}

/**
 * 判断一条消息的文本里是否 @ 了机器人自己。走 entities 里的 "mention" 类型
 * （@username 形式），按 offset/length 截出实际文本再跟机器人的 username 比对，
 * 不用简单的字符串 includes——避免把「@somebody_else_bot」这种子串误判成命中。
 */
function isBotMentioned(message: Message, botUsername: string | undefined): boolean {
  if (!botUsername || typeof message.text !== "string") return false;
  const entities = message.entities;
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

/**
 * 判断一条消息的文本里是否 @ 了机器人自己以外的某个用户。逻辑与 isBotMentioned
 * 对称（同样只认 entities 里的 "mention" 类型），排除掉的那一个就是机器人自己：
 * 消息里 @ 别人，大概率是在跟那个人说话，不是在给机器人递话头，随机搭话
 * 贸然插进去会很突兀，所以只用来抑制 isRandomTrigger（见下方调用点），不影响
 * 「回复机器人」「@ 机器人」这两条本就明确指向机器人的必回路径——这两种
 * 情况即便消息里同时 @ 了别人，机器人被叫到也该照常回。
 */
function mentionsOtherUser(message: Message, botUsername: string | undefined): boolean {
  if (!botUsername || typeof message.text !== "string") return false;
  const entities = message.entities;
  if (!entities) return false;
  const botTarget: string = `@${botUsername}`.toLowerCase();
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentionText: string = message.text.substring(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mentionText !== botTarget) return true;
    }
  }
  return false;
}

/**
 * 判断一条更新是不是机器人自己发出的消息原样回弹，命中就要整条跳过自动
 * 流水线（不记入 AI 对话缓存、不触发 AI 回复、不随机复读、不洗澡触发），
 * 否则会被自己的内容再触发一轮，自说自话。
 *
 * 内联结果消息（如 /luck_challenge 的 via_bot 消息）不走这里，是更早一步
 * 单独识别、单独处理的，见 handleIncomingMessage 顶部与 recordSelfInlineResult：
 * 那类消息虽然也是机器人生成的内容，但要自录入 AI 对话缓存（让模型知道
 * 自己刚说过这句话），只是不该触发主动行为，语义和这里的「纯回弹去重」
 * 不同，不能合并成一条 true/false。
 *
 * 普通群消息 Telegram 不会推回给发送者自己，但机器人在自己管理的频道发帖
 * 时，channel_post 更新不区分发帖者，会原样推回来；转发进关联讨论组的
 * 自动转发副本同理（forward_origin 指回原帖，is_automatic_forward 标记这是
 * 频道→讨论组的自动转发而非用户手动转发）。这两种回弹都靠
 * infra/selfSentTracker.ts 的登记表识别——机器人发送时（无论主线程还是哪个
 * Worker）都会把 chatId/messageId 登记进去，见 infra/telegram.ts 的
 * sendMessage/copyMessage/sendSticker 与 aiChat.ts 对 Worker "sent" 事件的
 * 转登记。
 */
function isBotOwnMessage(message: Message): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin = message.forward_origin;
  if (message.is_automatic_forward === true && origin?.type === "channel" && isSelfSent(origin.chat.id, origin.message_id)) return true;
  return false;
}

/**
 * 内联结果消息（如 /luck_challenge 抽到的运势/概率文本）的自录：用 botId/
 * botFirstName 当发言人、lastName 留空，与「看看」/随机复读的自录手法一致
 * （见 handleIncomingMessage 底部两处 recordChatMessage 调用），让 AI 认得出
 * 这是自己刚说过的话，被问起时能接上，而不是凭空冒出一句不知道是谁说的
 * 运势结果。gate 条件对齐其它记录点：私聊、复制目标进行中、本群未开 AI
 * 闲聊都不录；调用方拿到后无论是否录成都会直接 return，不触发下面任何
 * 主动行为（不复读、不触发 AI 回复、不洗澡）——这部分行为本就靠
 * isBotOwnMessage 之前的提前返回保证，这里只负责「要不要留个记忆」。
 */
function recordSelfInlineResult(message: Message, botId: number, botFirstName: string): void {
  if (message.chat.type === "private") return;
  if (typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (getActiveCopyIn(chatId)) return;
  if (getChatState(chatId).isUseAIChat !== true) return;
  recordChatMessage(chatId, botId, botFirstName, "", message.text);
}

/**
 * 从一条图片消息的 photo 尺寸档位（Telegram 按分辨率从小到大排列）里挑给
 * 视觉模型用的那一档：从最大往下找第一个不超过下载上限的（file_size 是
 * 可选字段，缺失按可用对待——photo 是 Telegram 压缩过的 jpeg，实际很少
 * 超限，上限只是防御性护栏）；都超限就退回最小档，交给下载侧的大小检查
 * 兜底（见 ai/imageDescription.ts）。file_id 用来下载，file_unique_id 是
 * 同图重发时恒定的去重键（见 ai/imageDescription.ts 的临时描述缓存），
 * 两个 id 必须取自同一档位才对得上号。
 */
function pickPhotoFile(sizes: PhotoSize[]): { fileId: string; fileUniqueId: string } {
  for (let i = sizes.length - 1; i >= 0; i--) {
    const size: PhotoSize = sizes[i]!;
    if (!size.file_size || size.file_size <= MEDIA_MAX_DOWNLOAD_BYTES) {
      return { fileId: size.file_id, fileUniqueId: size.file_unique_id };
    }
  }
  return { fileId: sizes[0]!.file_id, fileUniqueId: sizes[0]!.file_unique_id };
}

/**
 * 选出一个 GIF（Telegram animation，实际多为 mp4）用于视觉解析的下载素材：
 * 本项目没有视频解码/抽帧能力，只能分析 Telegram 自带的缩略图（通常是
 * jpg，封面帧画面）；没有缩略图（罕见）则放弃视觉解析，返回 null。返回的
 * fileUniqueId 恒为 animation 自身的 file_unique_id（同 ai/stickerSets.ts
 * 的 pickStickerVisionSource 同一道理：与实际下载来源解耦，保证同一个 GIF
 * 无论何时重发都记在同一个缓存键下）。
 */
function pickAnimationVisionSource(animation: Animation): { fileId: string; fileUniqueId: string } | null {
  const thumbnailFileId: string | undefined = animation.thumbnail?.file_id;
  if (!thumbnailFileId) return null;
  return { fileId: thumbnailFileId, fileUniqueId: animation.file_unique_id };
}

/**
 * ja 模式在本群被关闭（`/ja_copy disable`）时，退化为原样复读而非硬跳过整条
 * 复读——只是不再调用翻译，复读本身照常发生。`/ja_copy` 指令入口自己已经
 * 单独拒绝（见 commands/copy.ts），这里覆盖的是另外两处会绕过指令入口直接
 * 用到 "ja" 模式的路径：沿用中的 /ja_copy 复读会话（disable 只改开关，不会
 * 主动打断正在进行的会话）、以及随机复读抽中 "ja" 的情形——两处都不经过
 * copy.ts 的入口检查，之前会无视这个开关继续调用翻译 API。
 */
function resolveEffectiveCopyMode(chatId: number, mode: CopyMode | undefined): CopyMode | undefined {
  if (mode === "ja" && getChatState(chatId).isJATranslationEnabled === false) return undefined;
  return mode;
}

/**
 * 将一条消息复读回它所在的聊天，并按给定模式做文本变换。
 * @param mode 要应用的文本变换（undefined 表示原样复读）。
 * @param expectedTargetId 若这是在复读某个锁定目标（而非无目标时的随机复读），
 *   传入该目标的 id：翻译等待期间会重新核对复读是否仍然有效，见函数体注释；
 *   无目标的随机复读不传，跳过这层核对（本就没有"目标"这个不变量要维护）。
 * @returns 实际发出去的文本（变换后的文本，或原样复读时的原文），供调用方
 *   决定要不要自录进 AI 对话缓存（见两处调用点：/copy 锁定目标期间故意不录，
 *   随机复读会录）；纯媒体消息（没有 text）、发送失败、或复读在等待期间
 *   已经失效则返回 undefined。
 */
async function echoMessage(chatId: number, message: Message, mode: CopyMode | undefined, expectedTargetId?: number): Promise<string | undefined> {
  const text: string = message.text || "";
  // 不复读指令消息，防止指令无限解析
  if (text.startsWith("/")) return undefined;

  // 安全校验：只对"纯文本"消息本身做变换（有 text、无 entities、非媒体）；
  // 带格式/链接/@提及的消息一旦被反转或拼接后缀，会破坏 entity 的偏移量，
  // 可能被用来伪造看似正常、实际指向别处的链接/提及，所以这类消息以及
  // 非文本消息一律走原样 copyMessage，不做任何文本变换。
  const plainText: string | undefined =
    typeof message.text === "string" &&
    (!message.entities || message.entities.length === 0)
      ? message.text
      : undefined;

  const transformed: string | null = plainText !== undefined
    ? await applyCopyModeTransform(plainText, mode)
    : null;

  // globalCopyState 是跨群共享的全局状态，不受 index.ts 里按 chat 分道的
  // sequentialize 保护：/stop_copy 在任何群都能停（见 commands/copy.ts），
  // 完全可能在上面的翻译等待期间从另一个群并发跑完并清空目标。这里用
  // 调用方传入的 expectedTargetId 重新核对一次，避免出现"用户在别的群已经
  // 收到复读已停止的确认，这个群却还是补发了一条复读"的场景；无目标的
  // 随机复读不传 expectedTargetId，天然跳过。
  if (expectedTargetId !== undefined && getActiveCopyIn(chatId)?.copiedUser.id !== expectedTargetId) {
    return undefined;
  }

  if (transformed !== null) {
    // 变换后的文本只当作纯文本发送（sendMessage 不带 parse_mode），不会被
    // Telegram 当作 HTML/Markdown 解析，也就不存在把用户输入拼进富文本
    // 导致的格式/链接注入问题。
    const sentMessageId: number | undefined = await sendMessage(chatId, transformed);
    return sentMessageId !== undefined ? transformed : undefined;
  }

  // 无变换模式、非纯文本消息、或变换本身失败（如翻译出错）都退化为原样转发。
  const copiedMessageId: number | undefined = await copyMessage(chatId, chatId, message.message_id);
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}

/**
 * 判断一条消息是否有可以被 copyMessage 复制的实际内容。随机复读要靠它过滤掉
 * 置顶提示、成员变动之类的服务消息——对这类消息调用 copyMessage 必然报错。
 * （被 /copy 锁定的目标不走这个过滤：TA 的消息本就该尽数复读，个别复制失败
 * 记日志即可。）
 */
function hasCopyableContent(message: Message): boolean {
  return !!(
    message.text || message.caption || message.photo || message.sticker ||
    message.animation || message.video || message.video_note || message.audio ||
    message.voice || message.document || message.dice || message.contact ||
    message.location || message.venue || message.poll || message.story
  );
}

/**
 * 处理每一条收到的 message/channel_post：刷新发送者缓存。如果消息来自当前
 * 正在被复制的目标、且发生在发起 /copy 的那个群里，则将其复读回同一个聊天；
 * 如果本群当前没有复读进行中，则以 RANDOM_ECHO_PROBABILITY 的概率随机挑一种
 * 模式复读这条消息（东一榔头西一棒子地刷存在感）。
 *
 * 最前面依次过两道门，命中任一道都不再往下走：
 * - via_bot 指向自己：内联结果消息（如 /luck_challenge），自录入 AI 对话
 *   缓存后直接返回，见 recordSelfInlineResult。（运势抽签的确认落盘不在
 *   这里做——文本认领挂在 index.ts 的 isInit 网关之前，不然转发进未 /init
 *   群的结果副本根本到不了本函数，见 commands/luckChallenge.ts 的
 *   confirmLuckDraw。）
 * - isBotOwnMessage：机器人自己发出消息的原样回弹（频道自回环），整条跳过、
 *   连记忆都不留。
 */
export async function handleIncomingMessage(ctx: Context): Promise<void> {
  const message: Message | undefined = ctx.msg;
  if (!message) return;
  // 顺手用这条更新自带的 chat.title 刷新群名称记录（零额外 API 开销，见
  // infra/chatTitle.ts）；与下面自弹回环/复读等判断无关，任何一条更新都能
  // 提供最新群名，不必等它们判定完。
  recordChatTitleFromChat(message.chat);
  if (message.via_bot?.id === ctx.me.id) {
    recordSelfInlineResult(message, ctx.me.id, ctx.me.first_name);
    return;
  }
  if (isBotOwnMessage(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message);
  const state: ChatState = getChatState(chatId);

  // 复读目标全局唯一，但复读只发生在发起 /copy 的那个群里（判定统一走
  // getActiveCopyIn）——同一个目标在别的群发言不复读，别的群的 AI 闲聊/
  // 随机复读也不因此被抑制。
  const activeCopy = getActiveCopyIn(chatId);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (activeCopy && senderId === activeCopy.copiedUser.id) {
    await echoMessage(chatId, message, resolveEffectiveCopyMode(chatId, activeCopy.copyMode), activeCopy.copiedUser.id);
    return;
  }

  // 私聊消息不参与下面任何群聊向的自动行为（AI 闲聊/看看触发/随机复读，
  // 机器人在私聊里没有群聊上下文，也不该在 DM 里自动搭话）；唯一的例外是
  // /send 中转会话（isUseProxySend，见 commands/send.ts、ChatState 该字段
  // 注释）：这个私聊如果正在中转中，把消息原样转发进目标群一次。/send 命令
  // 本身走 index.ts 的 bot.command 单独处理，不会走到这里；这里处理的都是
  // 中转期间发的其余消息。
  if (message.chat.type === "private") {
    if (state.isUseProxySend === true && state.proxySendTargetChatId !== undefined) {
      const targetChatId: number = state.proxySendTargetChatId;
      const copiedMessageId: number | undefined = await copyMessage(targetChatId, chatId, message.message_id);
      if (copiedMessageId === undefined) {
        // 转发失败（机器人被踢出目标群/丢了发言权限等，copyMessage 内部已
        // 记过日志）：不能让中转继续悄悄吞掉后续消息、超管却还以为在正常
        // 转发——直接关掉这轮会话并如实告知，逼超管确认目标群状态后重新
        // /send，好过无限期静默丢消息。isUseProxySend 刚判过是 true，说明
        // state 是 Map 里的真实条目（不是共享的冻结默认值，道理同
        // commands/quiet.ts 的 handleUnquietCommand），可以直接改。
        state.isUseProxySend = false;
        state.proxySendTargetChatId = undefined;
        await saveState();
        await sendMessage(chatId, `转发到 ${targetChatId} 失败了，本天才先把这轮中转停掉了，检查一下再 /send 重新开吧♡`);
      }
    }
    return;
  }

  // /quiet 静默期内暂停一切主动刷存在感的行为（AI 随机插话、洗澡「看看」、
  // 随机复读），只保留被动触发（回复机器人 / @ 机器人）和指令。
  const isQuiet: boolean = (state.quietUntil ?? 0) > Date.now();

  // 本群的 AI 闲聊开关（state.json 里按群配置 isUseAIChat，见 ChatState）：
  // 缺省关闭，需群管理员通过 /ai_chat enable 显式开启。关闭的群连对话缓存都
  // 不攒（攒了也没有会消费它的回复流水线），回复/@ 机器人也不再回。
  const aiChatEnabled: boolean = state.isUseAIChat === true;

  const messageText: string | undefined = typeof message.text === "string" ? message.text : undefined;
  if (!activeCopy && aiChatEnabled && messageText && !messageText.startsWith("/")) {
    // 把带文本的普通消息滚动记入本群的 AI 对话缓存（Bot API 无法拉历史，只能
    // 边收边攒，上限见 consts/aiChat.ts 的 VERBATIM_CONTEXT_MAX）。指令消息
    // （/ 开头）已在上面排除。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, messageText);

    // AI 闲聊回复：用户回复机器人、或者消息里 @ 了机器人 → 必然触发；否则
    // 普通发言按 AI_REPLY_PROBABILITY 概率触发。这里的掷骰只决定「给不给
    // 模型一次机会」——随机触发命中后回不回、怎么回由模型在 Worker 侧自主
    // 决定，允许什么都不做保持沉默（见 workers/aiChatWorker.ts 的
    // generateAndSendReply）。命中后就不再走下面的洗澡/随机复读，免得一条
    // 消息既被 AI 回又被复读。
    const repliedTo: Message | undefined = message.reply_to_message;
    const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === ctx.me.id;
    const isMentioned: boolean = isBotMentioned(message, ctx.me.username);

    // 消息里 @ 了别人（非机器人自己）时不参与随机搭话的概率判定——见
    // mentionsOtherUser 注释；不影响上面 isReplyToBot/isMentioned 这两条
    // 本就明确指向机器人的必回路径。
    const isRandomTrigger: boolean =
      !isReplyToBot && !isMentioned && !isQuiet &&
      !mentionsOtherUser(message, ctx.me.username) &&
      Math.random() < AI_REPLY_PROBABILITY &&
      tryClaimUserRandomReply(chatId, speaker.id);

    if (isReplyToBot || isMentioned || isRandomTrigger) {
      generateAndSendReply(chatId, message.message_id, isReplyToBot ? repliedTo?.text : undefined, isRandomTrigger);
      return;
    }
  } else if (!activeCopy && aiChatEnabled && message.sticker) {
    // 贴纸消息没有文本：先备好现有的元数据兜底行（情绪 emoji、所属贴纸包，
    // 见 ai/stickerSets.ts 的 describeStickerForContext），再看有没有可用的
    // 视觉解析素材（静态贴纸下载本体；动态/视频贴纸没有可解码的本体，改用
    // 缩略图；两者都没有则放弃视觉，见 pickStickerVisionSource）。没有素材
    // 就直接记兜底行；有素材则交给 AI Worker 走占位/异步解析管线（见
    // aiChat.ts 的 recordChatMedia），解析成功原位回填画面描述，失败回填
    // 同一份兜底行，都不损失现状已有信息。只当上下文，不触发 AI 回复（评价
    // 例外见下方 commentOnResolve），也不 return——后面的随机复读本来就对
    // 贴纸生效，行为保持不变。
    const speaker = resolveSpeaker(message);
    const fallbackText: string = describeStickerForContext(message.sticker);
    const visionSource = pickStickerVisionSource(message.sticker);
    if (!visionSource) {
      recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, fallbackText);
    } else {
      // 例外：按 AI_REPLY_PROBABILITY 掷中时，解析完成后 AI 会回复那条贴纸
      // 消息评价它——文字随机搭话与图片/贴纸/GIF 评价共用同一个概率（不是
      // 各自独立掷骰），掷骰在这里（主线程调度逻辑），顺带套用 /quiet 静默
      // 与「群 × 用户」随机回复冷却——评价本质上也是主动搭话，别对同一个
      // 人短时间连评。
      const commentOnResolve: boolean =
        !isQuiet && Math.random() < AI_REPLY_PROBABILITY && tryClaimUserRandomReply(chatId, speaker.id);
      recordChatMedia(
        "sticker",
        chatId,
        speaker.id,
        speaker.firstName,
        speaker.lastName,
        "",
        visionSource.fileId,
        visionSource.fileUniqueId,
        message.message_id,
        commentOnResolve,
        fallbackText
      );
    }
  } else if (!activeCopy && aiChatEnabled && Array.isArray(message.photo) && message.photo.length > 0) {
    // 图片消息同样没有 text（配文在 caption 里），交给 AI Worker 先占位入
    // 缓存、异步解析出描述后原位回填（见 aiChat.ts 的 recordChatMedia）。
    // 基线与贴纸/GIF 同定位：只当上下文，不触发 AI 回复，也不 return——
    // 后面的随机复读对图片本来就生效，行为保持不变。相册（一次发多张）是
    // 多条相邻消息各带一张图，自然逐条走到这里，各自占位、各自解析。
    const speaker = resolveSpeaker(message);
    const caption: string = typeof message.caption === "string" ? message.caption : "";
    const commentOnResolve: boolean =
      !isQuiet && Math.random() < AI_REPLY_PROBABILITY && tryClaimUserRandomReply(chatId, speaker.id);
    const photoFile = pickPhotoFile(message.photo);
    recordChatMedia("photo", chatId, speaker.id, speaker.firstName, speaker.lastName, caption, photoFile.fileId, photoFile.fileUniqueId, message.message_id, commentOnResolve);
  } else if (!activeCopy && aiChatEnabled && message.animation) {
    // GIF（Telegram animation，实际多为 mp4）：本项目没有视频解码/抽帧能力，
    // 只能分析 Telegram 自带的缩略图（封面帧，见 pickAnimationVisionSource）。
    // 有缩略图就走占位/异步解析管线（同图片/贴纸）；没有缩略图（罕见）就
    // 只记一条占位纯文本，不触发解析、也不参与评价掷骰。
    const speaker = resolveSpeaker(message);
    const caption: string = typeof message.caption === "string" ? message.caption : "";
    const visionSource = pickAnimationVisionSource(message.animation);
    if (!visionSource) {
      recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, caption ? `[GIF] ${caption}` : "[GIF]");
    } else {
      const commentOnResolve: boolean =
        !isQuiet && Math.random() < AI_REPLY_PROBABILITY && tryClaimUserRandomReply(chatId, speaker.id);
      recordChatMedia("animation", chatId, speaker.id, speaker.firstName, speaker.lastName, caption, visionSource.fileId, visionSource.fileUniqueId, message.message_id, commentOnResolve);
    }
  }

  // 没有复读对象时，说到洗澡/泡澡/冲凉就回一句「看看」（触发词规则见
  // consts/auto.ts 的 BATH_TRIGGER_PATTERN 注释）。以 / 开头的是指令（未注册的、
  // 或发给其他机器人的指令不会被 bot.command 拦截，会落到这里），与
  // echoMessage 的「不复读指令消息」保持一致，不触发。私聊不触发——与 AI
  // 随机插话同理，这些刷存在感的行为都是群聊语境的。
  if (!activeCopy && !isQuiet && typeof message.text === "string" && !message.text.startsWith("/") && message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH && BATH_TRIGGER_PATTERN.test(message.text)) {
    const sentMessageId: number | undefined = await sendMessage(chatId, BATH_TRIGGER_REPLY_TEXT, message.message_id);
    // 自录进 AI 对话缓存，让模型知道自己刚说过这句——不然它凭空多出一句
    // 不知道是谁说的「看看」，后续被问起时接不上。isBotOwnMessage 那道门
    // 只挡自己消息的回弹（频道自回环）重新触发，记忆本身还是要留的
    // （短期进滚动缓存，随批次轮换自然被压缩进中期摘要，见
    // aiChatWorker.ts 的 recordChatMessage/scheduleRotation）。
    if (aiChatEnabled && sentMessageId !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", BATH_TRIGGER_REPLY_TEXT);
    }
    return;
  }

  // 没有复读对象时的随机复读（私聊不触发，同上）。无需担心和其他机器人形成
  // 复读循环：Telegram 保证机器人收不到其他机器人发的消息（官方为防止 bot
  // 互相触发死循环的设计）；普通群消息里自己发的也不会作为更新推送回来，
  // 频道场景的例外由 isBotOwnMessage 挡住（见其注释）。
  if (!activeCopy && !isQuiet && hasCopyableContent(message) && Math.random() < RANDOM_ECHO_PROBABILITY) {
    const mode: CopyMode | undefined = resolveEffectiveCopyMode(chatId, pickRandom(RANDOM_ECHO_MODES));
    const echoedText: string | undefined = await echoMessage(chatId, message, mode);
    // 同上，自录复读出去的文本（纯媒体复读没有文本可录，保持沉默）。
    if (aiChatEnabled && echoedText !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", echoedText);
    }
  }
}
