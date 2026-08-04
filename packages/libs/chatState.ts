import type { ChatState } from "../types/chatState";
import { QUIET_CLOCK_SKEW_TOLERANCE_MS, QUIET_MAX_DURATION_MS } from "../consts/commands";

/**
 * 墙钟回拨时拒绝把静默期延长到配置上限之外。
 *
 * 上限带一分钟容差（QUIET_CLOCK_SKEW_TOLERANCE_MS）：`/quiet <上限分钟数>`
 * 写下的 `quietUntil - now` 恰好等于 QUIET_MAX_DURATION_MS，不留容差的话主机
 * 时钟往回跳 1 毫秒就让顶格静默当场失效。超出容差的大幅回拨由
 * normalizeChatState 收敛到上限——那条路径保留静默、只缩短它，不再删字段。
 */
export function isQuietUntilActive(quietUntil: number | undefined, now: number = Date.now()): boolean {
  if (quietUntil === undefined || quietUntil <= now) return false;
  return quietUntil - now <= QUIET_MAX_DURATION_MS + QUIET_CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * 把单群状态收敛到唯一的持久化表示。布尔开关统一只保存偏离缺省值的状态：
 * AI、初始化、日语翻译、广告检测、防刷屏和中转均缺省关闭，因此 false 不落盘；
 * botIsAdmin 的 false 表示“已确认不是管理员”，与未知状态不同，必须保留。
 *
 * 已过期的 quietUntil 不再影响业务，也在这里回收。lockdown 即使已到期也
 * 不能删除：反刷群恢复流程仍需用其 originalPermissions 执行解锁。
 *
 * 「读数超出上限」与「已经到点」必须分开处置：前者的唯一成因是墙钟往回跳，
 * 删字段等于把这条静默从内存和 `state.json` 一并抹掉、时钟回正后也找不回来，
 * 而这个 normalizer 每次 `saveState()` 都会对每个群跑一遍。收敛到上限即可
 * ——静默继续有效，且保证不晚于 QUIET_MAX_DURATION_MS 结束，正是这条上限
 * JSDoc 本来的意思（同 libs/slidingWindowRateLimit.ts 对回拨「只丢越界项、
 * 绝不整窗清空」的取舍）。
 */
export function normalizeChatState(chatState: ChatState, now: number = Date.now()): ChatState {
  if (chatState.quietUntil !== undefined) {
    if (chatState.quietUntil <= now) delete chatState.quietUntil;
    else if (!isQuietUntilActive(chatState.quietUntil, now)) {
      chatState.quietUntil = now + QUIET_MAX_DURATION_MS;
    }
  }
  for (const toggle of [
    "isAIChatEnabled",
    "isJATranslationEnabled",
    "isAdDetectEnabled",
    "isFloodControlEnabled",
    "isInitEnabled",
    "isProxySendEnabled",
  ] as const) {
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
