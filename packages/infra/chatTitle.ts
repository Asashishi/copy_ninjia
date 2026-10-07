import type { Chat, ChatFullInfo } from "grammy/types";
import { telegramSignal } from "../libs/telegramSignal";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
import {
  getChatStateCache,
  getChatState,
  getOrCreateChatState,
  saveChatStateInBackground,
} from "./storage/stateStore";
import { chatTitleRefreshRuntime } from "../cache/main/chatTitle";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { runBoundedSettledBatch } from "../libs/boundedSettledBatch";
import type { BoundedBatchExecution } from "../libs/boundedSettledBatch";
import type { ChatState } from "../types/chatState";

/**
 * 各群名称的追踪与持久化（ChatState.title，随 SQLite 群状态行落盘）。群名称不
 * 参与业务判断，只用于核对数据库条目对应的群。
 *
 * 维护路径两条，互为补充：
 * 1. 启动时对已知的每个群现查一次（refreshAllChatTitles，见 app/lifecycle.ts）——
 *    覆盖存量群与上次运行期间改名的群；
 * 2. 此后每条收到的群消息，其 chat.title 随更新一起送达，不调 API，
 *    直接记录/刷新（recordChatTitleFromChat，见
 *    packages/auto/message/ 的 handleIncomingMessageMiddleware）。
 */

/**
 * 把确证的群名称写入内存 ChatState；未初始化的群（isInitEnabled !== true）或与已知值
 * 相同时不写并返回 false，同 infra/botAdmin.ts 的 recordBotChatPermissions，
 * 未初始化的群不建 `chat_states` 条目。
 * @returns 是否改写了名称，调用方据此决定是否落盘。
 */
function applyChatTitle(
  chatId: number,
  title: string,
  currentState: Readonly<ChatState>
): boolean {
  if (currentState.isInitEnabled !== true || currentState.title === title) return false;
  const chatState: ChatState = getOrCreateChatState(chatId);
  chatState.title = title;
  return true;
}

/** 名称有变化才后台落盘。 */
function recordChatTitle(
  chatId: number,
  title: string,
  currentState: Readonly<ChatState>
): void {
  if (applyChatTitle(chatId, title, currentState)) {
    saveChatStateInBackground(chatId, "chat title refresh");
  }
}

/**
 * 群消息/频道帖更新里顺手记录 chat.title，零额外 API 开销。私聊没有群名称，
 * 频道机器人不做任何管理，都不记录（同 infra/botAdmin.ts 的范围限定）。
 * @param currentState 同一同步消息入口已读取的当前群状态；缺省时本函数自行读取。
 */
export function recordChatTitleFromChat(
  chat: Chat,
  currentState?: Readonly<ChatState>
): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  recordChatTitle(chat.id, chat.title, currentState ?? getChatState(chat.id));
}

/**
 * 启动流程：给 SQLite 里已知的每个群现查一次当前群名称并回填。不阻塞
 * bot 启动主流程，个别群查询失败不影响其它群。app/lifecycle.ts 追踪该任务，并在
 * 最终持久化 flush 前等待它完成。共享的 bot.api 客户端把 429 请求退回主线程
 * query 类别队列。并发上限取 STATE_MANAGED_CHAT_LIMIT，即每个受管群各查一次。
 */
export async function refreshAllChatTitles(
  signal: AbortSignal = chatTitleRefreshRuntime.controller.signal
): Promise<void> {
  if (!chatTitleRefreshRuntime.accepting || signal.aborted) return;
  const chatIds: number[] = [...getChatStateCache().keys()];
  const total: number = chatIds.length;
  const startedAt: number = Date.now();
  let completed: number = 0;
  logger.info(`Chat title refresh started: total=${total}.`);
  await runBoundedSettledBatch<number, void>({
    items: chatIds,
    maxConcurrent: STATE_MANAGED_CHAT_LIMIT,
    execute: async ({ item: chatId }: BoundedBatchExecution<number>): Promise<void> => {
      if (signal.aborted) return;
      try {
        const chat: ChatFullInfo = await bot.api.getChat(chatId, telegramSignal(signal));
        if (!signal.aborted && (chat.type === "group" || chat.type === "supergroup")) {
          recordChatTitle(chatId, chat.title, getChatState(chatId));
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          // 单个群查询失败不中断其它群的回填。
          logger.error(`Failed to refresh chat title for chat ${chatId}:`, error);
        }
      } finally {
        completed++;
      }
    },
  });
  logger.info(
    `Chat title refresh ${signal.aborted ? "aborted" : "completed"}: ` +
    `${completed}/${total}, elapsed=${Date.now() - startedAt}ms.`
  );
}

export function initChatTitleRefresh(): void {
  chatTitleRefreshRuntime.controller = new AbortController();
  chatTitleRefreshRuntime.accepting = true;
}

export function quiesceChatTitleRefresh(): void {
  chatTitleRefreshRuntime.accepting = false;
}

export function abortChatTitleRefresh(): void {
  chatTitleRefreshRuntime.accepting = false;
  if (!chatTitleRefreshRuntime.controller.signal.aborted) chatTitleRefreshRuntime.controller.abort();
}
