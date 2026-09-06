import type { Context } from "grammy";
import type { ChatMember, Message } from "grammy/types";
import { WED_MEMBER_LIMIT } from "../../consts/wed";
import { noteWedMemberPresence } from "../../cache/main/wedMemberReview";
import { isPresentMember } from "../../libs/chatMember";
import { getOrCreateWedMemberState, markWedMembersDirty, removeWedMember } from "./persistence";
import { getChatState } from "../../infra/storage/stateStore";
import type { WedMemberState } from "../../types/wed";

/** 退群清理已有集合，在群更新保护在途复核；初始化网关也可调用，不建立群状态。 */
export function observeWedMemberDeparture(ctx: Context): boolean {
  const member: ChatMember | undefined = ctx.chatMember?.new_chat_member;
  if (member !== undefined && ctx.chat !== undefined && isPresentMember(member)) {
    noteWedMemberPresence(ctx.chat.id, member.user.id);
  }
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
  if (message?.new_chat_members !== undefined) {
    for (const member of message.new_chat_members) noteWedMemberPresence(ctx.chat.id, member.id);
  }
  if (message === undefined || message.is_automatic_forward === true || message.sender_chat !== undefined ||
    message.from === undefined || message.from.is_bot) return;
  if (message.new_chat_members !== undefined || message.pinned_message !== undefined) return;
  // 首次 /init 也能通过前置网关，但必须等实际启用后才开始记录发言成员。
  if (getChatState(ctx.chat.id).isInitEnabled !== true) return;
  noteWedMemberPresence(ctx.chat.id, message.from.id);
  const state: WedMemberState | undefined = getOrCreateWedMemberState(ctx.chat.id);
  if (state === undefined || state.members.has(message.from.id) || state.members.size >= WED_MEMBER_LIMIT) return;
  state.members.add(message.from.id);
  markWedMembersDirty(state);
}
