import type { Context } from "grammy";
import type { Chat, ChatMember, Message } from "grammy/types";
import { WED_MEMBER_LIMIT } from "../../consts/wed";
import { wedAvatarProbes } from "../../cache/main/wed";
import { noteWedMemberPresence } from "../../cache/main/wedMemberReview";
import { isPresentMember } from "../../libs/chatMember";
import { getOrCreateWedMemberState, markWedMembersDirty, removeWedMember } from "./persistence";
import { getChatState } from "../../infra/storage/stateStore";
import type { WedAvatarProbe, WedMemberState } from "../../types/wed";

/**
 * 退群清理已有集合，在群更新保护在途复核；初始化网关也可调用，不建立群状态。
 * `chat_member` 更新只推送给群管理员机器人，`left_chat_member` 服务消息在较大的超级群里
 * 可能缺失，离群信号因此可能不全，见 docs/cn/04-invariants.md。
 * @param chat 调用方已解析好的 `ctx.chat`；`ctx.chat` 每次读取都重新求值，由参数传入。
 */
export function observeWedMemberDeparture(ctx: Context, chat: Chat | undefined): boolean {
  const member: ChatMember | undefined = ctx.chatMember?.new_chat_member;
  if (member !== undefined && chat !== undefined && isPresentMember(member)) {
    noteWedMemberPresence(chat.id, member.user.id);
  }
  const leftId: number | undefined = member !== undefined && !isPresentMember(member)
    ? member.user.id : ctx.message?.left_chat_member?.id;
  if (leftId === undefined) return false;
  if (chat?.type === "group" || chat?.type === "supergroup") {
    removeWedMember(chat.id, leftId);
  }
  return true;
}

/** 只记录以个人身份实际发言的用户 ID；离群摘除用户，不从引用和自动转发扩充候选。 */
export function observeWedMembers(ctx: Context): void {
  // `ctx.chat` 每次读取都重新求值，这里取一次交给下面全部判定与退群分支。
  const chat: Chat | undefined = ctx.chat;
  if (chat?.type !== "group" && chat?.type !== "supergroup") return;
  if (observeWedMemberDeparture(ctx, chat)) return;
  const message: Message | undefined = ctx.message;
  if (message?.new_chat_members !== undefined) {
    for (const member of message.new_chat_members) noteWedMemberPresence(chat.id, member.id);
  }
  if (message === undefined || message.is_automatic_forward === true || message.sender_chat !== undefined ||
    message.from === undefined || message.from.is_bot) return;
  if (message.new_chat_members !== undefined || message.pinned_message !== undefined) return;
  // 首次 /init 也能通过前置网关，但必须等实际启用后才开始记录发言成员。
  if (getChatState(chat.id).isInitEnabled !== true) return;
  noteWedMemberPresence(chat.id, message.from.id);
  const probes: Set<WedAvatarProbe> | undefined = wedAvatarProbes.get(message.from.id);
  if (probes !== undefined) for (const probe of probes) probe.observedChats.add(chat.id);
  const state: WedMemberState | undefined = getOrCreateWedMemberState(chat.id);
  if (state === undefined || state.members.has(message.from.id) || state.members.size >= WED_MEMBER_LIMIT) return;
  state.members.add(message.from.id);
  markWedMembersDirty(state);
}
