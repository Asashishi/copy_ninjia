import type { Chat } from "@grammyjs/types";
import { logger } from "./logger";
import { bot } from "./telegram";
import { getAllChatStates, getChatState, getOrCreateChatState, saveStateInBackground } from "./storage/stateStore";
import { chatTitleRefreshRuntime } from "../cache/chatTitle";
import { CHAT_TITLE_REFRESH_CONCURRENCY } from "../consts/telegram";

/**
 * 各群名称的追踪与持久化（ChatState.title，随 state.json 落盘）。群名称不
 * 参与任何业务判断，纯粹是让人手动核对/编辑 state.json 时能一眼认出某个
 * chatId 是哪个群，不用逐个 chatId 去客户端反查。
 *
 * 维护路径两条，互为补充：
 * 1. 启动时对已知的每个群现查一次（refreshAllChatTitles，见 app/lifecycle.ts）——
 *    覆盖存量群、以及上次运行期间改过名但没能实时捕捉到的群；
 * 2. 此后每条收到的群消息，其 chat.title 本就随更新一起送达，不用额外
 *    调 API，顺手记录/刷新（recordChatTitleFromChat，见
 *    src/auto/message/ 的 handleIncomingMessage）。
 */

/**
 * 记录一次确证的群名称，与已知值不同才写入并落盘（避免高频群消息把这里
 * 变成每条消息都触发一次落盘）。未初始化的群（isInitEnabled !== true）不记录，
 * 理由同 infra/botAdmin.ts 的 recordBotAdminStatus——不能让只是被拉进去、
 * 从没人管过的群凭空在 state.json 里长出条目。
 */
function recordChatTitle(chatId: number, title: string): void {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState = getOrCreateChatState(chatId);
  if (chatState.title === title) return;
  chatState.title = title;
  saveStateInBackground("chat title refresh");
}

/**
 * 群消息/频道帖更新里顺手记录 chat.title，零额外 API 开销。私聊没有群名称，
 * 频道机器人不做任何管理，都不记录（同 infra/botAdmin.ts 的范围限定）。
 */
export function recordChatTitleFromChat(chat: Chat): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  recordChatTitle(chat.id, chat.title);
}

/**
 * 启动流程：给 state.json 里已知的每个群现查一次当前群名称并回填。不阻塞
 * bot 启动主流程——这纯粹是方便人读 state.json 的锦上添花，慢一点或个别
 * 群查询失败都不影响机器人正常运行。app/lifecycle.ts 会追踪该任务，并在
 * 最终状态快照前等待它完成，避免刷新任务在 flush 后继续改状态。共享的 bot.api 客户端
 * 自带限流+自动重试（见 infra/telegram/client.ts 的 apiThrottler/autoRetry）；本 owner
 * 仍使用固定小并发池，避免历史群一次性占满启动期的共享 Telegram 队列。
 */
export async function refreshAllChatTitles(
  signal: AbortSignal = chatTitleRefreshRuntime.controller.signal
): Promise<void> {
  if (!chatTitleRefreshRuntime.accepting || signal.aborted) return;
  const chatIds: number[] = [...getAllChatStates().keys()];
  const total: number = chatIds.length;
  const startedAt: number = Date.now();
  let nextIndex: number = 0;
  let completed: number = 0;
  logger.info(`Chat title refresh started: total=${total}, concurrency=${CHAT_TITLE_REFRESH_CONCURRENCY}.`);

  const workers: Promise<void>[] = Array.from(
    { length: Math.min(CHAT_TITLE_REFRESH_CONCURRENCY, total) },
    async (): Promise<void> => {
      while (!signal.aborted) {
        const index: number = nextIndex++;
        if (index >= total) return;
        const chatId: number = chatIds[index]!;
        try {
          const chat = await bot.api.getChat(
            chatId,
            signal as unknown as Parameters<typeof bot.api.getChat>[1]
          );
          if (!signal.aborted && (chat.type === "group" || chat.type === "supergroup")) {
            recordChatTitle(chatId, chat.title);
          }
        } catch (error: unknown) {
          if (!signal.aborted) {
            // 单个群查询失败不该中断其它群的回填。
            logger.error(`Failed to refresh chat title for chat ${chatId}:`, error);
          }
        } finally {
          completed++;
          if (completed === total || completed % 50 === 0) {
            logger.info(
              `Chat title refresh progress: ${completed}/${total}, elapsed=${Date.now() - startedAt}ms.`
            );
          }
        }
      }
    }
  );
  await Promise.allSettled(workers);
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
