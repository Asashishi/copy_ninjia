import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import type { FlushResult } from "../../types/lifecycle";
import { chatStateCache } from "../../cache/main/chatState";
import { globalCopyState, globalTtsUsageState, stateStoreHolder } from "../../cache/main/storage";
import {
  DEFAULT_CHAT_STATE,
  createChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../../libs/chatState";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type {
  CachedUser,
  ChatState,
  ChatStateOptionalField,
  ChatStateSwitchKey,
  CopyMode,
  DecodedGlobalCopyState,
  DecodedGlobalState,
  GlobalCopyState,
  GlobalState,
} from "../../types/chatState";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { assertChatStateCapacity } from "../chatStateStorage";
import { StateStore, assertLegacyStateFilesAbsent } from "./statePersistence";
import { toError } from "../../libs/errorMessage";

export {
  hydrateChatStateCache,
  persistChatState,
  saveChatStateInBackground,
} from "../chatStateStorage";

export { StateStore } from "./statePersistence";
export type { StateSaveOptions, StateStoreOptions } from "./statePersistence";

function sharedStateStore(): StateStore {
  stateStoreHolder.current ??= new StateStore();
  return stateStoreHolder.current;
}

/** 全局复读状态的只读视图；写入只经 adoptCopyTarget/clearCopyTarget 与复读冷却的两个函数。 */
export function getGlobalCopyState(): Readonly<GlobalCopyState> {
  return globalCopyState;
}

/**
 * 本群此刻的复读目标 id；没有目标、或目标锁在别的群时为 undefined。
 *
 * 不返回 `{ copiedUser, copyMode }` 投影对象：该判定挂在每条群消息与每次反应更新上
 * （auto/message/index.ts、auto/reactionSync.ts、echo.ts、guards.ts），调用点只需
 * 判断「是不是 TA」。需要整份身份的冷路径直接读 getGlobalCopyState()。
 */
export function activeCopyTargetIdIn(chatId: number): number | undefined {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) {
    return undefined;
  }
  return globalCopyState.copiedUser.id;
}

/**
 * 本群此刻生效的复读模式。调用方必须先用 activeCopyTargetIdIn 确认本群确有目标，
 * 否则这里的 undefined 分不清「没目标」还是「有目标但没指定模式」。
 */
export function activeCopyModeIn(chatId: number): CopyMode | undefined {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) {
    return undefined;
  }
  return globalCopyState.copyMode;
}

export function getChatStateCache(): ReadonlyMap<number, ChatState> {
  return chatStateCache;
}

export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStateCache) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
}

/**
 * 锁定复读目标：三元组整体写，不留「有目标但还没记群」的中间态。启动恢复与
 * `/copy` 系命令共用这一个写入边界（见 cache/main/storage.ts 的 globalCopyState）。
 */
export function adoptCopyTarget(copiedUser: CachedUser, copyMode: CopyMode | undefined, copyChatId: number): void {
  globalCopyState.copiedUser = copiedUser;
  globalCopyState.copyMode = copyMode;
  globalCopyState.copyChatId = copyChatId;
}

/** 解除复读目标：与 adoptCopyTarget 对称，三元组整体清空。lastCopyTime 是冷却
 *  记账，不属于这一组，解除时保持原值。 */
export function clearCopyTarget(): void {
  globalCopyState.copiedUser = null;
  globalCopyState.copyMode = undefined;
  globalCopyState.copyChatId = undefined;
}

/**
 * 占住全局复读冷却：同步写入新的冷却起点并返回原值，调用方放弃这次尝试时把两者
 * 交给 restoreCopyCooldown。只改内存，落盘由调用方经 persistGlobalState 完成（见
 * commands/copyShared.ts 的 claimCopyCooldownOrReject）。
 */
export function claimCopyCooldown(claimedAt: number): number | undefined {
  const previousLastCopyTime: number | undefined = globalCopyState.lastCopyTime;
  globalCopyState.lastCopyTime = claimedAt;
  return previousLastCopyTime;
}

/**
 * 回滚一次冷却占用：只在冷却起点仍是这次占用写入的值时恢复原值。
 * @returns 是否发生回滚；调用方据此决定是否落盘。
 */
export function restoreCopyCooldown(claimedAt: number, previousLastCopyTime: number | undefined): boolean {
  if (globalCopyState.lastCopyTime !== claimedAt) return false;
  globalCopyState.lastCopyTime = previousLastCopyTime;
  return true;
}

/** 启动恢复：拒绝未迁移的旧位置状态文件，再从 memory/global/state.json 恢复全局状态。 */
export async function loadState(): Promise<void> {
  try {
    await assertLegacyStateFilesAbsent();
    const decoded: DecodedGlobalState | null = await sharedStateStore().load();
    if (decoded === null) return;
    if (decoded.copy.lastCopyTime !== undefined) {
      globalCopyState.lastCopyTime = decoded.copy.lastCopyTime;
    }
    // 判别联合让 copyChatId 在这一支里就是 number（配对由 libs/stateFileCodec.ts 的 globalCopy 强制）。
    const copy: DecodedGlobalCopyState = decoded.copy;
    if (copy.copiedUser !== null) {
      adoptCopyTarget(copy.copiedUser, copy.copyMode, copy.copyChatId);
    }
    globalTtsUsageState.current = decoded.ttsUsage ?? null;
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
    throw error;
  }
}

function currentGlobalState(): GlobalState {
  return {
    copy: globalCopyState,
    ttsUsage: globalTtsUsageState.current ?? undefined,
  };
}

/** 语音合成每日计数的最新持久化值；null 表示从没用过。供 AI Worker 启动与重建时灌回。 */
export function getTtsUsage(): TtsDailyUsage | null {
  return globalTtsUsageState.current;
}

/**
 * 接管 AI Worker 回传的全量计数（ttsUsage 事件）并在后台落盘；写失败按 StateStore
 * 既有的重试与 fatal 通道处理。
 */
export function adoptTtsUsage(usage: TtsDailyUsage): void {
  globalTtsUsageState.current = usage;
  saveGlobalStateInBackground("record TTS daily usage");
}

/**
 * 全局状态的 durability barrier。值在调用同步栈内完成序列化，
 * 返回的 Promise 只会在对应 revision（或更新 revision）落盘后完成。
 */
export async function persistGlobalState(context: string): Promise<void> {
  throwIfUpdateAborted();
  try {
    await sharedStateStore().save(currentGlobalState());
    throwIfUpdateAborted();
  } catch (error: unknown) {
    throwIfUpdateAborted();
    const reason: Error = toError(error);
    throw new Error(`Failed to persist global state update (${context}): ${reason.message}`, { cause: error });
  }
}

export function setStatePersistenceFatalHandler(handler: ((error: Error) => void) | undefined): void {
  sharedStateStore().setFatalHandler(handler);
}

function saveGlobalStateInBackground(context: string): void {
  throwIfUpdateAborted();
  void sharedStateStore().save(currentGlobalState(), { waitForPersistence: false }).catch((error: unknown): void => {
    logger.error(`Failed to persist background global state update (${context}):`, error);
  });
}

export function flushStateToDisk(
  timeoutMs: number = STATE_FLUSH_TIMEOUT_MS,
  quiesce: boolean = false
): Promise<FlushResult> {
  return sharedStateStore().flush(timeoutMs, quiesce);
}

/**
 * 只读地查一个群的状态。没有条目时返回全局共享的 `DEFAULT_CHAT_STATE`，
 * 返回类型为 `Readonly<ChatState>`。要修改状态的调用方一律走 `getOrCreateChatState`。
 */
export function getChatState(chatId: number): Readonly<ChatState> {
  return chatStateCache.get(chatId) ?? DEFAULT_CHAT_STATE;
}

/**
 * 取可写的群状态；没有条目时先过容量闸（infra/chatStateStorage.ts 的
 * assertChatStateCapacity），再以规范形状新建并登记。
 */
export function getOrCreateChatState(chatId: number): ChatState {
  let chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (!chatState) {
    assertChatStateCapacity(chatId);
    // 规范形状一次建好；写入方只赋值，不往裸 `{}` 上一个个加字段（见
    // libs/chatState.ts 的 createChatState）。
    chatState = createChatState();
    chatStateCache.set(chatId, chatState);
  }
  return chatState;
}

/** 收敛刚被清除字段的群状态；整条回到缺省时摘除热读副本条目。 */
function settleClearedChatState(chatId: number, chatState: ChatState): void {
  normalizeChatState(chatState);
  if (isEmptyChatState(chatState)) chatStateCache.delete(chatId);
}

/**
 * 清除一个可选字段（置为 undefined）。字段本来就没设过时返回 false，不改动状态。
 * 调用方负责随后落盘。
 */
export function clearChatStateField(chatId: number, field: ChatStateOptionalField): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[field] === undefined) return false;
  chatState[field] = undefined;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 关闭一个群开关（置为 false）。开关本来就是关闭时返回 false，不改动状态。
 * 调用方负责随后落盘。
 */
export function disableChatStateSwitch(chatId: number, key: ChatStateSwitchKey): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[key] !== true) return false;
  chatState[key] = false;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 停管一个群时删除它的全部配置，但保留尚需恢复的 lockdown write-ahead 记录。
 *
 * 两条路径共用：`/init disable`（见 commands/init.ts）与机器人被移出群（见
 * infra/botAdmin.ts）。lockdown 是唯一例外：反刷群恢复流程仍要用它的
 * originalPermissions 解锁（同 libs/chatState.ts 的 normalizeChatState）。
 *
 * 无记录时不做任何事；调用方负责在同一 teardown 尾部统一落盘。清完后若整条状态
 * 回到缺省，这里会删掉热读副本条目，随后的 persistChatState 写出删除墓碑，SQLite 行
 * 一并消失（见 infra/chatStateStorage.ts 的 encodeCurrentChatState）。
 */
export function purgeChatStateExceptLockdown(chatId: number): void {
  const current: ChatState | undefined = chatStateCache.get(chatId);
  if (!current) return;
  if (current.lockdown === undefined) {
    chatStateCache.delete(chatId);
    return;
  }
  const retained: ChatState = createChatState();
  retained.lockdown = current.lockdown;
  chatStateCache.set(chatId, retained);
}
