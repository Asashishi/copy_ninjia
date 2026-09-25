import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { TRANSLATE_CHAT_USER_LIMIT } from "../consts/translate";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import {
  getChatState,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
} from "../infra/storage/stateStore";
import { isTelegramGroupChatId } from "../libs/telegramId";
import type { ChatState } from "../types/chatState";
import type { TranslateState } from "../types/translate";

/**
 * 翻译会话保存在群状态的 translate 字段，随 `chat_states` 持久化（见
 * types/chatState.ts）。每条群消息只读取现有会话，不创建投影对象。
 */
export function getTranslateState(chatId: number, userId: number): TranslateState | undefined {
  const states: readonly TranslateState[] | undefined = getChatState(chatId).translate;
  if (states === undefined) return undefined;
  for (const state of states) {
    if (state.translatedUser.id === userId) return state;
  }
  return undefined;
}

/**
 * 创建或替换本群一个目标的会话；同步检查群状态容量与每群人数，不淘汰其他目标。
 * 调用方随后经 persistChatState 落盘。
 */
export function setTranslateState(chatId: number, state: TranslateState): boolean {
  if (!isTelegramGroupChatId(chatId)) throw new Error("Translation chat ID must be a negative safe integer.");
  const existing: ChatState | undefined = getChatStateCache().get(chatId);
  if (existing === undefined && getChatStateCache().size >= STATE_MANAGED_CHAT_LIMIT) return false;
  const chatState: ChatState = existing ?? getOrCreateChatState(chatId);
  const current: readonly TranslateState[] | undefined = chatState.translate;
  if (current === undefined) {
    chatState.translate = [state];
    return true;
  }
  const index: number = current.findIndex((entry: TranslateState): boolean => entry.translatedUser.id === state.translatedUser.id);
  if (index < 0 && current.length >= TRANSLATE_CHAT_USER_LIMIT) return false;
  const updated: TranslateState[] = [...current];
  if (index < 0) updated.push(state);
  else updated[index] = state;
  chatState.translate = updated;
  return true;
}

/** 停止本群全部或指定目标的翻译并等待群状态落盘；重复停止也确认持久化。 */
export async function stopTranslation(chatId: number, userId?: number): Promise<void> {
  const chatState: ChatState | undefined = getChatStateCache().get(chatId);
  const current: readonly TranslateState[] | undefined = chatState?.translate;
  if (chatState !== undefined && current !== undefined) {
    const remaining: readonly TranslateState[] = userId === undefined
      ? []
      : current.filter((entry: TranslateState): boolean => entry.translatedUser.id !== userId);
    chatState.translate = remaining.length === 0 ? undefined : remaining;
  }
  await persistChatState(chatId, "translation stopped");
}

registerChatTeardown("translate", (chatId: number): Promise<void> => stopTranslation(chatId));
