import { wedChats } from "../../cache/main/wed";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../consts/telegram";
import { deleteMessages } from "../../infra/telegram";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type { WedChat, WedMemberState, WedSession } from "../../types/wed";
import { getOrCreateWedMemberState } from "./persistence";

/**
 * 只由通过初始化网关的群交互创建；成员集合满额（STATE_MANAGED_CHAT_LIMIT）时
 * 拒绝新群，因此交互表与成员集合同界，不需要淘汰。
 */
export function getOrCreateWedChat(chatId: number): WedChat | undefined {
  let chat: WedChat | undefined = wedChats.get(chatId);
  if (chat !== undefined) return chat;
  const state: WedMemberState | undefined = getOrCreateWedMemberState(chatId);
  if (state === undefined) return undefined;
  chat = { controller: new AbortController(), members: state.members, sessions: new Map(), departed: false };
  wedChats.set(chatId, chat);
  return chat;
}

/**
 * 群关闭同步取消排队及会话；忙碌项由自身 finally 清理。
 *
 * 机器人已离群（`departed`）时结果一条也删不掉：作废全部消息 id 并置位 `departed`，忙碌项的
 * finally（含重抽时被替换、已不在会话表里的旧结果）随之不再发删除请求。其余起因把此刻空闲的
 * 结果按 deleteMessages 的单次上限分批删除，整批成功才作废这一批的消息 id。
 */
export async function teardownWedChat(
  chatId: number,
  chat: WedChat,
  reason: ChatTeardownReason
): Promise<void> {
  const idle: WedSession[] = [];
  const idleMessageIds: number[] = [];
  chat.controller.abort();
  if (reason === "departed") chat.departed = true;
  for (const session of chat.sessions.values()) {
    if (reason === "departed") {
      session.messageId = undefined;
    } else if (!session.busy && session.messageId !== undefined) {
      idle.push(session);
      idleMessageIds.push(session.messageId);
    }
    session.controller.abort();
  }
  for (let start: number = 0; start < idle.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
    const end: number = start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX;
    if (!await deleteMessages(chatId, idleMessageIds.slice(start, end))) continue;
    for (const session of idle.slice(start, end)) session.messageId = undefined;
  }
}
