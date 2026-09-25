import { wedChats } from "../../cache/main/wed";
import type { WedChat, WedMemberState, WedSession } from "../../types/wed";
import { removeWedResult } from "./messages";
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
  chat = { controller: new AbortController(), members: state.members, sessions: new Map() };
  wedChats.set(chatId, chat);
  return chat;
}

/** 群关闭同步取消排队及会话；只删除此刻空闲的结果，忙碌项由自身 finally 清理。 */
export async function teardownWedChat(chat: WedChat): Promise<void> {
  const idle: WedSession[] = [];
  chat.controller.abort();
  for (const session of chat.sessions.values()) {
    if (!session.busy) idle.push(session);
    session.controller.abort();
  }
  for (const session of idle) await removeWedResult(session);
}
