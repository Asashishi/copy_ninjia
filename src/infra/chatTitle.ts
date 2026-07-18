import type { Chat } from "@grammyjs/types";
import { logger } from "./logger";
import { bot } from "./telegram";
import { getAllChatStates, getChatState, getOrCreateChatState, saveStateInBackground } from "./storage";

/**
 * 各群名称的追踪与持久化（ChatState.title，随 state.json 落盘）。群名称不
 * 参与任何业务判断，纯粹是让人手动核对/编辑 state.json 时能一眼认出某个
 * chatId 是哪个群，不用逐个 chatId 去客户端反查。
 *
 * 维护路径两条，互为补充：
 * 1. 启动时对已知的每个群现查一次（refreshAllChatTitles，见 index.ts）——
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
 * 群查询失败都不影响机器人正常运行，没必要拖住 runner 开始消费更新的时机
 * （见 index.ts 对本函数的调用方式：fire-and-forget）。共享的 bot.api 客户端
 * 自带限流+自动重试（见 infra/telegram/client.ts 的 apiThrottler/autoRetry），这里
 * 并发发起全部请求即可，不需要自己再实现一层排队。
 */
export async function refreshAllChatTitles(): Promise<void> {
  const chatIds: number[] = [...getAllChatStates().keys()];
  await Promise.all(chatIds.map(async (chatId: number): Promise<void> => {
    try {
      const chat = await bot.api.getChat(chatId);
      if (chat.type === "group" || chat.type === "supergroup") {
        recordChatTitle(chatId, chat.title);
      }
    } catch (error: unknown) {
      // 单个群查询失败（机器人已被踢出/群已解散等）不该中断其它群的回填，
      // 记日志留痕即可，下次启动或下一条该群消息自然有机会补上。
      logger.error(`Failed to refresh chat title for chat ${chatId}:`, error);
    }
  }));
}
