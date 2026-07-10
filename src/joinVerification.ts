import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { CachedUser, PendingVerification } from "./types";
import { sendMessage, deleteMessage, deleteMessageAfter, kickChatMember, joinVerificationApi, KICK_NOTICE_AUTO_DELETE_MS } from "./telegram";
import { formatUserLabel } from "./userLabel";
import { isLockedDown, recordJoin } from "./antiRaid";

/** 新成员必须在 VERIFICATION_TIMEOUT_MS 内发送的精确文本，否则会被踢出。 */
const VERIFICATION_CODE: string = "purrvox";
const VERIFICATION_TIMEOUT_MS: number = 1 * 60 * 1000;
/**
 * 私密模式下直接踢人的占位记录存活时长：只是给 chat_member 更新和
 * new_chat_members 服务消息（针对同一次入群各自触发）留出去重窗口，
 * 不是真的验证超时，所以远比 VERIFICATION_TIMEOUT_MS 短。
 */
const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;

// 仅存于内存中，符合需求——不会在重启后保留。以 "chatId:userId" 为键，
// 这样同一个人在不同群里会被独立追踪。
const pendingVerifications: Map<string, PendingVerification> = new Map();

function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function memberLabel(member: any): string {
  const cachedShape: CachedUser = { id: member.id, username: member.username, first_name: member.first_name };
  return formatUserLabel(cachedShape);
}

/** 某个 ChatMember 是否实际还在聊天中（相对于已离开/已被踢出而言）。 */
function isActiveChatMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member;
  return true; // "member" | "administrator" | "creator"
}

/**
 * 删除某个待验证成员被追踪的所有消息（如果有的话，包括入群公告、机器人的
 * 提醒消息，以及 TA 在等待期间发送的任何内容），将其踢出聊天，并发布一条通知
 * ——此时提到过 TA 的入群公告/提醒消息都已被删除，这条通知是关于谁被移除、
 * 为何被移除的唯一痕迹。在 1 分钟窗口到期、仍未收到正确口令时执行。
 */
async function expireVerification(chatId: number, userId: number): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (!pending) return; // 已通过验证，或已经因为中途退群等原因被清理掉了
  pendingVerifications.delete(key);

  for (const messageId of pending.messageIds) {
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  await kickChatMember(chatId, userId, joinVerificationApi);
  const noticeMessageId: number | undefined = await sendMessage(chatId, `啧，${pending.label} 磨磨蹭蹭 1 分钟都交不出口令，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`, undefined, joinVerificationApi);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS, joinVerificationApi);
  }
}

/**
 * 为新加入的成员启动（如果已在等待中则补充）一个验证窗口。设计上是幂等的：
 * `chat_member` 更新和 `new_chat_members` 服务消息（群组未隐藏入群消息时）
 * 可能针对同一次入群各自独立触发本函数，后到达的那一次应该只是补充其消息 ID，
 * 而不是重启计时器/再发一次提醒。
 * @param chatId 成员加入的聊天。
 * @param member 新加入的用户（id/username/first_name），一定不是机器人。
 * @param announcementMessageId 若本次调用是由 `new_chat_members` 服务消息触发，则为该消息的 ID（用于之后删除）。
 */
async function ensureVerificationStarted(chatId: number, member: any, announcementMessageId?: number): Promise<void> {
  if (member.is_bot) return; // 机器人（包括本天才自己）不需要验证

  const key: string = verificationKey(chatId, member.id);
  const existing = pendingVerifications.get(key);
  if (existing) {
    if (announcementMessageId !== undefined) {
      if (existing.kicked) {
        // 这个人已经在私密模式下被直接踢出了，这条才姗姗来迟的入群公告/服务
        // 消息也顺手清理掉，不需要留着等占位记录自然过期。
        await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      } else {
        existing.messageIds.push(announcementMessageId);
      }
    }
    return;
  }

  // 反防刷群统计：只在真正新建待验证记录时计数一次，chat_member 更新和
  // new_chat_members 服务消息若针对同一次入群各自触发本函数，不会被重复计数。
  recordJoin(chatId);

  // 群聊当前处于反防刷群触发的私密模式：这波入群高峰大概率还在持续，新成员
  // 大概率也是刷量的一部分，跳过质询流程直接踢出（kickChatMember 只是踢出、
  // 不封禁，以防误杀正常用户，之后仍可正常申请加入）。
  if (isLockedDown(chatId)) {
    // 占位记录：chat_member 更新和 new_chat_members 服务消息可能针对同一次
    // 入群各自触发本函数，必须在任何 await 之前同步插入，防止后到达的那次
    // 因为查不到 existing 而重新 recordJoin/重新踢一次。
    pendingVerifications.set(key, {
      chatId,
      userId: member.id,
      label: memberLabel(member),
      messageIds: [],
      timeout: setTimeout(() => pendingVerifications.delete(key), LOCKDOWN_KICK_DEDUPE_MS),
      kicked: true,
    });

    // 删除公告 + 踢人不等待完成就返回：grammY 对同一批 update 是严格顺序处理的
    // （见 handleUpdates 里 "handle updates sequentially" 的注释），如果这里
    // await 网络请求，刷屏入群的后续 update 会被卡在队列里排队等这一次踢人
    // 走完，拖慢整批处理速度。
    void (async (): Promise<void> => {
      if (announcementMessageId !== undefined) {
        await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
      }
      await kickChatMember(chatId, member.id, joinVerificationApi);
    })().catch((error: unknown) => {
      console.error("Error kicking member during anti-raid lockdown:", error);
    });
    return;
  }

  const pending: PendingVerification = {
    chatId,
    userId: member.id,
    label: memberLabel(member),
    messageIds: announcementMessageId !== undefined ? [announcementMessageId] : [],
    timeout: setTimeout(() => {
      void expireVerification(chatId, member.id).catch((error: unknown) => {
        console.error("Error expiring join verification:", error);
      });
    }, VERIFICATION_TIMEOUT_MS),
  };
  pendingVerifications.set(key, pending);

  // 提醒消息同样不等待发送完成：入群提醒会经过限流的 joinVerificationApi，
  // 在真实刷群场景下，若这里 await，同一批入群 update 会被严格顺序处理的
  // grammY 卡住逐个排队等发消息，可能导致 15 秒的反防刷群计数窗口在真正数满
  // 阈值之前就先重置——刷群反而检测不到。发送结果异步回填 messageIds 即可，
  // 不影响后续到期清理。
  const reminderText: string =
    `喂，${memberLabel(member)}，新来的杂鱼给本天才听好了，` +
    `1 分钟内发一句 "${VERIFICATION_CODE}" 证明你不是机器人，` +
    `不然本天才就把你的发言全部抹掉再一脚把你踢出去哦♡`;
  void sendMessage(chatId, reminderText, undefined, joinVerificationApi)
    .then((reminderMessageId: number | undefined) => {
      if (reminderMessageId === undefined) return;
      if (pendingVerifications.get(key) === pending) {
        pending.messageIds.push(reminderMessageId);
      } else {
        // 限流排队太久，提醒消息落地时验证已经结束了（过期清理/通过/中途离群）。
        // 过期清理已经删完了该成员的所有痕迹，这条迟到的提醒不删的话会永远留在
        // 聊天里点名一个早已被踢走的人，所以直接删掉。
        void deleteMessage(chatId, reminderMessageId, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      console.error("Error sending join verification reminder:", error);
    });
}

/** 取消一个待验证记录，但不处理消息——用于该成员已经离开的情况。 */
function cancelVerification(chatId: number, userId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingVerifications.delete(key);
  }
}

/**
 * 处理 `chat_member` 更新：这是权威且始终会送达的入群/离群信号（不同于
 * `new_chat_members`/`left_chat_member` 服务消息——一旦群组开启了"隐藏入群/
 * 离群消息"，这些服务消息就完全不会再发送）。要接收非机器人自身成员的这类
 * 更新，需要机器人是群管理员——而封禁/删除消息本来也需要这个权限。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update = ctx.chatMember;
  if (!update) return;

  const user = update.new_chat_member.user;
  if (user.is_bot) return;

  const chatId: number = update.chat.id;
  const wasActive: boolean = isActiveChatMember(update.old_chat_member);
  const isActive: boolean = isActiveChatMember(update.new_chat_member);

  if (!wasActive && isActive) {
    await ensureVerificationStarted(chatId, user);
  } else if (wasActive && !isActive) {
    cancelVerification(chatId, user.id);
  }
}

/**
 * 追踪某个待验证成员的消息以便之后删除，并检查它是否为验证口令——如果是，
 * 验证立即通过。
 * @returns 若该消息就是验证成功的口令，返回 true（调用方此时应停止对其做进一步
 * 处理，例如不要复读/复制它）。
 */
async function trackPendingMessage(message: any): Promise<boolean> {
  const userId: number | undefined = message.from?.id;
  if (userId === undefined) return false;

  const key: string = verificationKey(message.chat.id, userId);
  const pending = pendingVerifications.get(key);
  // kicked 为 true 时这只是私密模式踢人后的去重占位，不是真的在等验证口令。
  if (!pending || pending.kicked) return false;

  pending.messageIds.push(message.message_id);

  const text: string = typeof message.text === "string" ? message.text.trim().toLowerCase() : "";
  if (text !== VERIFICATION_CODE) return false;

  clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await sendMessage(message.chat.id, `哼，算你机灵，${memberLabel(message.from)} 通过验证啦，欢迎杂鱼入群~♡`, undefined, joinVerificationApi);
  return true;
}

/**
 * 接入通用消息处理器的入口函数：在群组未隐藏 `new_chat_members`/
 * `left_chat_member` 服务消息时顺带捕获它们（以便这些消息的 ID 也能被
 * 追踪/清理），同时追踪待验证用户的消息并检查验证口令。入群/离群本身的检测
 * 由 handleChatMemberUpdate 驱动——与这些服务消息不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过自身处理逻辑（入群/离群公告，
 * 以及验证成功的口令），返回 true；否则返回 false，让消息正常继续流转。
 */
export async function handleGroupJoinVerification(message: any): Promise<boolean> {
  if (message.new_chat_members && message.new_chat_members.length > 0) {
    for (const member of message.new_chat_members) {
      await ensureVerificationStarted(message.chat.id, member, message.message_id);
    }
    return true;
  }

  if (message.left_chat_member) {
    cancelVerification(message.chat.id, message.left_chat_member.id);
    return false;
  }

  return trackPendingMessage(message);
}
