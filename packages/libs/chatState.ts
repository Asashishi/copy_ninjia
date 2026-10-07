import type { ChatState } from "../types/chatState";
import { QUIET_CLOCK_SKEW_TOLERANCE_MS, QUIET_MAX_DURATION_MS } from "../consts/commands";

/**
 * ChatState 的规范形状：所有字段在这里按固定顺序一次初始化，此后只赋值、不
 * `delete`。各开关默认 false；其余字段以 `undefined` 表示从没设过。
 *
 * 所有创建方都经本构造器，对象形状一致（antiRaid/updateIngress.ts、
 * antiRaid/floodControl.ts、antiRaid/adCandidate.ts、auto/message/index.ts、
 * aiChat/availability.ts 为主要读取方）。
 *
 * 持久化时状态编码器只写入已设置的字段与为 true 的开关（见
 * database/codec/chatState.ts）。
 */
export function createChatState(): ChatState {
  return {
    quietUntil: undefined,
    lockdown: undefined,
    isAIChatEnabled: false,
    isTranslationEnabled: false,
    isAdDetectEnabled: false,
    isFloodControlEnabled: false,
    isAntiRaidEnabled: false,
    isInitEnabled: false,
    botPermissions: undefined,
    title: undefined,
    isProxySendEnabled: false,
    translate: undefined,
  };
}

/**
 * 没有条目的群共用的只读缺省状态，形状与 createChatState() 一致（由
 * test/consts/immutability.test.ts 锁定）。不可变性由 `Readonly<ChatState>` 在编译期
 * 表达。
 */
export const DEFAULT_CHAT_STATE: Readonly<ChatState> = createChatState();

/**
 * 把解码出来的一份群状态按固定字段顺序逐字段抄进规范形状，结果与
 * createChatState() 同一个隐藏类。
 */
export function adoptChatState(decoded: Readonly<ChatState>): ChatState {
  const chatState: ChatState = createChatState();
  chatState.quietUntil = decoded.quietUntil;
  chatState.lockdown = decoded.lockdown;
  chatState.isAIChatEnabled = decoded.isAIChatEnabled;
  chatState.isTranslationEnabled = decoded.isTranslationEnabled;
  chatState.isAdDetectEnabled = decoded.isAdDetectEnabled;
  chatState.isFloodControlEnabled = decoded.isFloodControlEnabled;
  chatState.isAntiRaidEnabled = decoded.isAntiRaidEnabled;
  chatState.isInitEnabled = decoded.isInitEnabled;
  chatState.botPermissions = decoded.botPermissions;
  chatState.title = decoded.title;
  chatState.isProxySendEnabled = decoded.isProxySendEnabled;
  chatState.translate = decoded.translate;
  return chatState;
}

/**
 * 静默期是否仍有效；墙钟回拨时拒绝把静默期延长到配置上限之外。
 *
 * 上限带容差（QUIET_CLOCK_SKEW_TOLERANCE_MS）：`quietUntil - now` 不超过
 * QUIET_MAX_DURATION_MS 加容差即有效。超出容差的大幅回拨由 normalizeChatState
 * 收敛到上限，保留静默、缩短时长。
 */
export function isQuietUntilActive(quietUntil: number | undefined, now: number = Date.now()): boolean {
  if (quietUntil === undefined || quietUntil <= now) return false;
  return quietUntil - now <= QUIET_MAX_DURATION_MS + QUIET_CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * 保存前收敛单群状态：已到期的 quietUntil 置为 undefined；因墙钟回拨而超出
 * QUIET_MAX_DURATION_MS 的静默收敛到当前时刻加上限，静默继续有效。lockdown 即使
 * 已到期也保留，反刷群恢复流程仍需用其 originalPermissions 解锁。只赋值不
 * `delete`，形状契约见 createChatState。
 */
export function normalizeChatState(chatState: ChatState, now: number = Date.now()): ChatState {
  if (chatState.quietUntil !== undefined) {
    if (chatState.quietUntil <= now) chatState.quietUntil = undefined;
    else if (!isQuietUntilActive(chatState.quietUntil, now)) {
      chatState.quietUntil = now + QUIET_MAX_DURATION_MS;
    }
  }
  return chatState;
}

/**
 * 是否所有字段都还是缺省值：开关全为 false，其余字段全为 undefined。
 * `botPermissions` 只要存在就不算缺省：其中全 false 是「已确认不是管理员」，与
 * 「没查过」不同（见 types/chatState.ts）。
 */
export function isEmptyChatState(chatState: ChatState): boolean {
  return chatState.quietUntil === undefined &&
    chatState.lockdown === undefined &&
    !chatState.isAIChatEnabled &&
    !chatState.isTranslationEnabled &&
    !chatState.isAdDetectEnabled &&
    !chatState.isFloodControlEnabled &&
    !chatState.isAntiRaidEnabled &&
    !chatState.isInitEnabled &&
    chatState.botPermissions === undefined &&
    chatState.title === undefined &&
    !chatState.isProxySendEnabled &&
    chatState.translate === undefined;
}
