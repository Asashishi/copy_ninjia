import type { Context } from "grammy";
import type { ChatMember } from "@grammyjs/types";
import type { CachedUser, PendingVerification } from "./types";
import { sendMessage, deleteMessage, deleteMessageAfter, kickChatMember, joinVerificationApi, KICK_NOTICE_AUTO_DELETE_MS } from "./telegram";
import { formatUserLabel } from "./userLabel";

/** The exact text a new member must send within VERIFICATION_TIMEOUT_MS to avoid being kicked. */
const VERIFICATION_CODE: string = "purrvox";
const VERIFICATION_TIMEOUT_MS: number = 1 * 60 * 1000;

// In-memory only, per the ask — no persistence across restarts. Keyed by
// "chatId:userId" so the same person is tracked independently per group.
const pendingVerifications: Map<string, PendingVerification> = new Map();

function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function memberLabel(member: any): string {
  const cachedShape: CachedUser = { id: member.id, username: member.username, first_name: member.first_name };
  return formatUserLabel(cachedShape);
}

/** Whether a ChatMember is actually present in the chat (as opposed to having left/been kicked). */
function isActiveChatMember(member: ChatMember): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.status === "restricted") return member.is_member;
  return true; // "member" | "administrator" | "creator"
}

/**
 * Deletes every message tracked for a pending verification (join
 * announcement if any, the bot's reminder, and anything the user sent while
 * pending), kicks them from the chat, and posts a notice about it — the join
 * announcement/reminder that named them are gone by this point, so the
 * notice is the only trace left of who got removed and why.
 * Runs when the 1-minute window expires without the correct code.
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
 * Starts (or, if already pending, augments) a verification window for a
 * newly-joined member. Idempotent by design: both the `chat_member` update
 * and the `new_chat_members` service message (when the group doesn't hide
 * join messages) can independently trigger this for the same join, and
 * whichever arrives second should just contribute its message ID rather than
 * restart the timer / send a second reminder.
 * @param chatId The chat the member joined.
 * @param member The joining user (id/username/first_name), never a bot.
 * @param announcementMessageId The `new_chat_members` service message's ID, if this call was triggered by that message (used for later deletion).
 */
async function ensureVerificationStarted(chatId: number, member: any, announcementMessageId?: number): Promise<void> {
  if (member.is_bot) return; // 机器人（包括本天才自己）不需要验证

  const key: string = verificationKey(chatId, member.id);
  const existing = pendingVerifications.get(key);
  if (existing) {
    if (announcementMessageId !== undefined) existing.messageIds.push(announcementMessageId);
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

  const reminderText: string =
    `喂，${memberLabel(member)}，新来的杂鱼给本天才听好了，` +
    `1 分钟内发一句 "${VERIFICATION_CODE}" 证明你不是机器人，` +
    `不然本天才就把你的发言全部抹掉再一脚把你踢出去哦♡`;
  const reminderMessageId: number | undefined = await sendMessage(chatId, reminderText, undefined, joinVerificationApi);
  if (reminderMessageId !== undefined) {
    pending.messageIds.push(reminderMessageId);
  }
}

/** Cancels a pending verification without touching messages — used when the member is already gone. */
function cancelVerification(chatId: number, userId: number): void {
  const key: string = verificationKey(chatId, userId);
  const pending = pendingVerifications.get(key);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingVerifications.delete(key);
  }
}

/**
 * Handles `chat_member` updates: the authoritative, always-delivered signal
 * for join/leave (unlike the `new_chat_members`/`left_chat_member` service
 * messages, which stop being sent entirely if the group has "hide join/leave
 * messages" enabled). Requires the bot to be a chat admin to receive these
 * for members other than itself — which it already needs to be, to ban/delete.
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
 * Tracks a pending member's message for later deletion, and checks whether it
 * is the verification code — if so, verification succeeds immediately.
 * @returns true if the message was the successful verification code (caller
 * should stop further processing of it, e.g. not echo/copy it).
 */
async function trackPendingMessage(message: any): Promise<boolean> {
  const userId: number | undefined = message.from?.id;
  if (userId === undefined) return false;

  const key: string = verificationKey(message.chat.id, userId);
  const pending = pendingVerifications.get(key);
  if (!pending) return false;

  pending.messageIds.push(message.message_id);

  const text: string = typeof message.text === "string" ? message.text.trim().toLowerCase() : "";
  if (text !== VERIFICATION_CODE) return false;

  clearTimeout(pending.timeout);
  pendingVerifications.delete(key);
  await sendMessage(message.chat.id, `哼，算你机灵，${memberLabel(message.from)} 通过验证啦，欢迎杂鱼入群~♡`, undefined, joinVerificationApi);
  return true;
}

/**
 * Entry point wired into the generic message handler: opportunistically picks
 * up the `new_chat_members`/`left_chat_member` service messages (when the
 * group doesn't hide them, so their message IDs can be tracked/cleaned up
 * too), and tracks pending-user messages while checking for the verification
 * code. Join/leave detection itself is driven by handleChatMemberUpdate,
 * which — unlike these service messages — always fires.
 * @returns true if the message was fully handled here and the caller should
 * skip its own processing (join/leave announcements and successful
 * verification codes); false to let the message flow through normally.
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
