import type { ChatState } from "../types/chatState";

/**
 * 把单群状态收敛到唯一的持久化表示。布尔开关统一只保存偏离缺省值的状态：
 * AI、初始化、日语翻译和中转均缺省关闭，因此 false 不落盘；botIsAdmin 的
 * false 表示“已确认不是管理员”，与未知状态不同，必须保留。
 *
 * 已过期的 quietUntil 不再影响业务，也在这里回收。lockdown 即使已到期也
 * 不能删除：反刷群恢复流程仍需用其 originalPermissions 执行解锁。
 */
export function normalizeChatState(chatState: ChatState, now: number = Date.now()): ChatState {
  if (chatState.quietUntil !== undefined && chatState.quietUntil <= now) delete chatState.quietUntil;
  for (const toggle of ["isAIChatEnabled", "isJATranslationEnabled", "isInitEnabled", "isProxySendEnabled"] as const) {
    if (chatState[toggle] === false) delete chatState[toggle];
  }

  for (const key of Object.keys(chatState) as (keyof ChatState)[]) {
    if (chatState[key] === undefined) delete chatState[key];
  }
  return chatState;
}

export function isEmptyChatState(chatState: ChatState): boolean {
  return Object.keys(chatState).length === 0;
}

/** 规范化 Map 中的一条状态；若没有有效字段则连 Map 条目一起删除。 */
export function normalizeChatStateEntry(
  chatStates: Map<number, ChatState>,
  chatId: number,
  now: number = Date.now()
): ChatState | undefined {
  const chatState: ChatState | undefined = chatStates.get(chatId);
  if (!chatState) return undefined;
  normalizeChatState(chatState, now);
  if (isEmptyChatState(chatState)) {
    chatStates.delete(chatId);
    return undefined;
  }
  return chatState;
}
