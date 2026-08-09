import type { ChatState } from "../types/chatState";
import { QUIET_CLOCK_SKEW_TOLERANCE_MS, QUIET_MAX_DURATION_MS } from "../consts/commands";

/**
 * ChatState 的规范形状：**所有字段在这里一次性初始化到位，此后只赋值、绝不
 * `delete`**。「没设过」由 `undefined` 表示，不由「键不存在」表示。
 *
 * 这是热调用点的形状契约（AGENTS.md：热调用点必须保持对象 shape 稳定、不得事后
 * 增删字段）。每条群消息要读 4~6 次 `getChatState(chatId).isXEnabled`
 * （antiRaid/updateIngress.ts、antiRaid/floodControl.ts、antiRaid/adCandidate.ts、
 * auto/message/index.ts、aiChat/availability.ts）。此前每个写入方各自往一个裸
 * `{}` 上加一个不同的字段、normalizeChatState 每次 saveState 又对所有群 `delete`
 * 一遍，于是没有两个群的隐藏类相同，那几处读取全部退化成 megamorphic。
 * 本机 Bun 1.3.14 实测（3 轮 2M 预热 + 20M 计时读，独立进程重复两次）：
 * 统一形状 6.02 / 6.26 ns/op，加后再删的发散形状 10.67 / 12.68 ns/op。
 *
 * **磁盘格式不变**：`JSON.stringify` 天然跳过取值为 `undefined` 的键，因此
 * state.json 里仍然只出现偏离缺省值的字段，与改成 `delete` 之前逐字节一致。
 */
export function createChatState(): ChatState {
  return {
    quietUntil: undefined,
    lockdown: undefined,
    isAIChatEnabled: undefined,
    isJATranslationEnabled: undefined,
    isAdDetectEnabled: undefined,
    isFloodControlEnabled: undefined,
    isAntiRaidEnabled: undefined,
    isInitEnabled: undefined,
    botIsAdmin: undefined,
    title: undefined,
    isProxySendEnabled: undefined,
  };
}

/**
 * 没有条目的群共用的只读缺省状态。形状必须与 createChatState() 完全一致——
 * 否则 getChatState 的返回值会在「有条目」和「没条目」之间来回换隐藏类，
 * 前面那份基准白做（形状一致性由 test/consts/immutability.test.ts 钉住）。
 * 不可变性由 `Readonly<ChatState>` 在编译期表达，不用 Object.freeze。
 */
export const DEFAULT_CHAT_STATE: Readonly<ChatState> = createChatState();

/**
 * 把解码出来的一份群状态搬进规范形状。
 *
 * `JSON.parse` 产出的对象只带文件里真正出现过的键，各群互不相同；直接放进
 * chatStates 就等于把磁盘上的稀疏形状带进热路径。逐字段抄写而不是对象展开：
 * 展开的结果形状取决于两个来源的键集合，写死字段顺序才能保证与
 * createChatState() 同一个隐藏类。
 */
export function adoptChatState(decoded: Readonly<ChatState>): ChatState {
  const chatState: ChatState = createChatState();
  chatState.quietUntil = decoded.quietUntil;
  chatState.lockdown = decoded.lockdown;
  chatState.isAIChatEnabled = decoded.isAIChatEnabled;
  chatState.isJATranslationEnabled = decoded.isJATranslationEnabled;
  chatState.isAdDetectEnabled = decoded.isAdDetectEnabled;
  chatState.isFloodControlEnabled = decoded.isFloodControlEnabled;
  chatState.isAntiRaidEnabled = decoded.isAntiRaidEnabled;
  chatState.isInitEnabled = decoded.isInitEnabled;
  chatState.botIsAdmin = decoded.botIsAdmin;
  chatState.title = decoded.title;
  chatState.isProxySendEnabled = decoded.isProxySendEnabled;
  return chatState;
}

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
 * AI、初始化、日语翻译、广告检测、防刷屏、入群守卫和中转均缺省关闭，因此
 * false 不落盘；
 * botIsAdmin 的 false 表示“已确认不是管理员”，与未知状态不同，必须保留。
 *
 * 已过期的 quietUntil 不再影响业务，也在这里回收。lockdown 即使已到期也
 * 不能删除：反刷群恢复流程仍需用其 originalPermissions 执行解锁。
 *
 * 「读数超出上限」与「已经到点」必须分开处置：前者的唯一成因是墙钟往回跳，
 * 清掉字段等于把这条静默从内存和 `state.json` 一并抹掉、时钟回正后也找不回来，
 * 而这个 normalizer 每次 `saveState()` 都会对每个群跑一遍。收敛到上限即可
 * ——静默继续有效，且保证不晚于 QUIET_MAX_DURATION_MS 结束，正是这条上限
 * JSDoc 本来的意思（同 libs/slidingWindowRateLimit.ts 对回拨「只丢越界项、
 * 绝不整窗清空」的取舍）。
 *
 * 收敛一律写 `undefined` 而不是 `delete`：这个函数每次保存都要对**每个群**跑
 * 一遍，`delete` 会把每条状态踢出它的隐藏类，而它们正躺在每条群消息的读取路径
 * 上（形状契约见 createChatState）。落盘结果不受影响——`JSON.stringify` 跳过
 * 取值为 `undefined` 的键。
 */
export function normalizeChatState(chatState: ChatState, now: number = Date.now()): ChatState {
  if (chatState.quietUntil !== undefined) {
    if (chatState.quietUntil <= now) chatState.quietUntil = undefined;
    else if (!isQuietUntilActive(chatState.quietUntil, now)) {
      chatState.quietUntil = now + QUIET_MAX_DURATION_MS;
    }
  }
  for (const toggle of [
    "isAIChatEnabled",
    "isJATranslationEnabled",
    "isAdDetectEnabled",
    "isFloodControlEnabled",
    "isAntiRaidEnabled",
    "isInitEnabled",
    "isProxySendEnabled",
  ] as const) {
    if (chatState[toggle] === false) chatState[toggle] = undefined;
  }
  return chatState;
}

/**
 * 是否所有字段都还是缺省值。逐字段判定而不是数 `Object.keys().length`：规范形状
 * 下键一直都在，数出来恒为 11。
 *
 * `botIsAdmin === false` 不算缺省——那是「已确认不是管理员」，与「没查过」是两
 * 回事（见 types/chatState.ts）。
 */
export function isEmptyChatState(chatState: ChatState): boolean {
  return chatState.quietUntil === undefined &&
    chatState.lockdown === undefined &&
    chatState.isAIChatEnabled === undefined &&
    chatState.isJATranslationEnabled === undefined &&
    chatState.isAdDetectEnabled === undefined &&
    chatState.isFloodControlEnabled === undefined &&
    chatState.isAntiRaidEnabled === undefined &&
    chatState.isInitEnabled === undefined &&
    chatState.botIsAdmin === undefined &&
    chatState.title === undefined &&
    chatState.isProxySendEnabled === undefined;
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
