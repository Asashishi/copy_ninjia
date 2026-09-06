import type { Context } from "grammy";
import type { ChatMember, Message } from "grammy/types";
import { wedChats } from "../../cache/main/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { WED_MEMBER_LIMIT } from "../../consts/wed";
import { isPresentMember } from "../../libs/chatMember";
import { getOrCreateWedMemberState, markWedMembersDirty, removeWedMember } from "./persistence";
import { getChatState } from "../../infra/storage/stateStore";
import type { WedChat, WedMemberState } from "../../types/wed";

/** 只由通过初始化网关的群更新创建，群数满额时拒绝扩容。 */
export function getOrCreateWedChat(chatId: number): WedChat | undefined {
  let chat: WedChat | undefined = wedChats.get(chatId);
  if (chat !== undefined) return chat;
  if (wedChats.size >= STATE_MANAGED_CHAT_LIMIT) return undefined;
  const state: WedMemberState | undefined = getOrCreateWedMemberState(chatId);
  if (state === undefined) return undefined;
  chat = { controller: new AbortController(), members: state.members, sessions: new Map() };
  wedChats.set(chatId, chat);
  return chat;
}

/** 退群只清理已有集合；初始化网关拒绝业务更新时也可调用，不建立群状态。 */
export function observeWedMemberDeparture(ctx: Context): boolean {
  const member: ChatMember | undefined = ctx.chatMember?.new_chat_member;
  const leftId: number | undefined = member !== undefined && !isPresentMember(member)
    ? member.user.id : ctx.message?.left_chat_member?.id;
  if (leftId === undefined) return false;
  if (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") {
    removeWedMember(ctx.chat.id, leftId);
  }
  return true;
}

/** 只记录以个人身份实际发言的用户 ID；离群摘除用户，不从引用和自动转发扩充候选。 */
export function observeWedMembers(ctx: Context): void {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return;
  if (observeWedMemberDeparture(ctx)) return;
  const message: Message | undefined = ctx.message;
  if (message === undefined || message.is_automatic_forward === true || message.sender_chat !== undefined ||
    message.from === undefined || message.from.is_bot) return;
  if (message.new_chat_members !== undefined || message.pinned_message !== undefined) return;
  // 首次 /init 也能通过前置网关，但必须等实际启用后才开始记录发言成员。
  if (getChatState(ctx.chat.id).isInitEnabled !== true) return;
  const state: WedMemberState | undefined = getOrCreateWedMemberState(ctx.chat.id);
  if (state === undefined || state.members.has(message.from.id) || state.members.size >= WED_MEMBER_LIMIT) return;
  state.members.add(message.from.id);
  markWedMembersDirty(state);
}
