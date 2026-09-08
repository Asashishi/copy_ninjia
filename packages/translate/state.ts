import { translateStates } from "../cache/main/translateState";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { TRANSLATE_CHAT_USER_LIMIT } from "../consts/translate";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { persistGlobalState } from "../infra/storage/stateStore";
import { isTelegramGroupChatId } from "../libs/telegramId";
import type { TranslateState } from "../types/translate";

/** 每条群消息只读取现有会话，不创建投影对象。 */
export function getTranslateState(chatId: number, userId: number): TranslateState | undefined {
  const states: readonly TranslateState[] | undefined = translateStates.get(chatId);
  if (states === undefined) return undefined;
  for (const state of states) {
    if (state.translatedUser.id === userId) return state;
  }
  return undefined;
}

/** 创建或替换本群一个目标的会话；同步检查群数与每群人数，不淘汰其他目标。 */
export function setTranslateState(chatId: number, state: TranslateState): boolean {
  if (!isTelegramGroupChatId(chatId)) throw new Error("Translation chat ID must be a negative safe integer.");
  if (!translateStates.has(chatId) && translateStates.size >= STATE_MANAGED_CHAT_LIMIT) {
    return false;
  }
  const current: readonly TranslateState[] | undefined = translateStates.get(chatId);
  if (current === undefined) {
    translateStates.set(chatId, [state]);
    return true;
  }
  const index: number = current.findIndex((entry: TranslateState): boolean => entry.translatedUser.id === state.translatedUser.id);
  if (index < 0 && current.length >= TRANSLATE_CHAT_USER_LIMIT) return false;
  const updated: TranslateState[] = [...current];
  if (index < 0) updated.push(state);
  else updated[index] = state;
  translateStates.set(chatId, updated);
  return true;
}

/** 停止本群全部或指定目标的翻译并等待主、备落盘；重复停止也确认持久化。 */
export async function stopTranslation(chatId: number, userId?: number): Promise<void> {
  if (userId === undefined) translateStates.delete(chatId);
  else {
    const current: readonly TranslateState[] | undefined = translateStates.get(chatId);
    if (current !== undefined) {
      const remaining: readonly TranslateState[] = current.filter((entry: TranslateState): boolean => entry.translatedUser.id !== userId);
      if (remaining.length === 0) translateStates.delete(chatId);
      else translateStates.set(chatId, remaining);
    }
  }
  await persistGlobalState("translation stopped");
}

registerChatTeardown("translate", (chatId: number): Promise<void> => stopTranslation(chatId));
