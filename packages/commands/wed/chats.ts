import { wedChats, wedRuntime } from "../../cache/main/wed";
import { WED_CHAT_CACHE_MAX_ENTRIES } from "../../consts/wed";
import { trackBackgroundTask } from "../../infra/backgroundTasks";
import { logger } from "../../infra/logger";
import { runWithUpdateAbortSignal } from "../../infra/updateContext";
import type { WedChat, WedMemberState, WedSession } from "../../types/wed";
import { removeWedResult } from "./messages";
import { getOrCreateWedMemberState } from "./persistence";

/**
 * 只由通过初始化网关的群交互创建；命中刷新 LRU，满额先取消最旧群并跟踪结果清理。
 * 清理归属运行时，独立于触发淘汰的 update；停机约束见 docs/cn/04-invariants.md。
 */
export function getOrCreateWedChat(chatId: number): WedChat | undefined {
  let chat: WedChat | undefined = wedChats.get(chatId);
  if (chat !== undefined) return chat;
  const state: WedMemberState | undefined = getOrCreateWedMemberState(chatId);
  if (state === undefined) return undefined;
  if (wedChats.size >= WED_CHAT_CACHE_MAX_ENTRIES) {
    for (const [oldestId, oldest] of wedChats) {
      wedChats.delete(oldestId);
      if (wedRuntime.current !== null) {
        const cleanup: Promise<void> = runWithUpdateAbortSignal(
          wedRuntime.current.controller.signal,
          (): Promise<void> => teardownWedChat(oldest)
        );
        trackBackgroundTask(wedRuntime.current.tasks, cleanup, "Failed to clean up evicted wed chat:");
      } else {
        void teardownWedChat(oldest).catch((error: unknown): void => {
          logger.error("Failed to clean up evicted wed chat:", error);
        });
      }
      break;
    }
  }
  chat = { controller: new AbortController(), members: state.members, sessions: new Map() };
  wedChats.set(chatId, chat);
  return chat;
}

/** 淘汰和群关闭同步取消排队及会话；只删除此刻空闲的结果，忙碌项由自身 finally 清理。 */
export async function teardownWedChat(chat: WedChat): Promise<void> {
  const idle: WedSession[] = [];
  chat.controller.abort();
  for (const session of chat.sessions.values()) {
    if (!session.busy) idle.push(session);
    session.controller.abort();
  }
  for (const session of idle) await removeWedResult(session);
}
