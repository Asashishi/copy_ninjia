import { STATE_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import type { FlushResult } from "../../types/lifecycle";
import { chatStateCache } from "../../cache/main/chatState";
import { globalAssetState, globalCopyState, stateStoreHolder } from "../../cache/main/storage";
import {
  BOT_DEFAULT_AVATAR_URL,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
} from "../../consts/ui/assets";
import {
  DEFAULT_CHAT_STATE,
  createChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../../libs/chatState";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, StateFileSchema } from "../../types/chatState";
import type { ReadonlyLruCache } from "../../libs/lruCache";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { assertChatStateCapacity } from "../chatStateStorage";
import { StateStore } from "./statePersistence";

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

export function getGlobalCopyState(): GlobalCopyState {
  return globalCopyState;
}

export function getActiveCopyIn(chatId: number): { copiedUser: CachedUser; copyMode: CopyMode | undefined } | null {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) return null;
  return { copiedUser: globalCopyState.copiedUser, copyMode: globalCopyState.copyMode };
}

/**
 * 「未卜先知」内联结果此刻该用的缩略图直链。
 *
 * 四个取值函数都直接返回**最终可用值**而不是 `string | undefined`：与
 * agent 能力配置不同，这里的缺省只对应一个内置常量；语义在这里收敛一次，
 * 调用点就不必各自记得兜底。
 */
export function getFortuneThumbnailUrl(): string {
  return globalAssetState.fortuneThumbnailUrl ?? FORTUNE_THUMBNAIL_URL;
}

/** 「概率论」内联结果此刻该用的缩略图直链；缺省语义同上。 */
export function getProbabilityThumbnailUrl(): string {
  return globalAssetState.probabilityThumbnailUrl ?? PROBABILITY_THUMBNAIL_URL;
}

/** gag 发言内联结果此刻该用的缩略图直链；缺省语义同上。 */
export function getGagThumbnailUrl(): string {
  return globalAssetState.gagThumbnailUrl ?? GAG_THUMBNAIL_URL;
}

/**
 * 复原机器人头像时该抓的那张默认脸；缺省语义同上。
 *
 * 取值在主线程完成、URL 作为参数传进 infra/telegram/avatar/restore.ts 的
 * restoreDefaultProfilePhoto：该实现被 aiChat 与 antiRaid 两条 Worker 一并
 * import，不能碰只属于主线程的 cache/main/storage.ts（见 docs/cn/04-invariants.md
 * 的缓存线程归属）。
 */
export function getBotDefaultAvatarUrl(): string {
  return globalAssetState.botDefaultAvatarUrl ?? BOT_DEFAULT_AVATAR_URL;
}

export function getChatStateCache(): ReadonlyLruCache<number, ChatState> {
  return chatStateCache;
}

export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStateCache) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
}

function adoptCopyTarget(copiedUser: CachedUser, copyMode: CopyMode | undefined, copyChatId: number): void {
  globalCopyState.copiedUser = copiedUser;
  globalCopyState.copyMode = copyMode;
  globalCopyState.copyChatId = copyChatId;
}

export async function loadState(): Promise<void> {
  try {
    const decoded: StateFileSchema | null = await sharedStateStore().load();
    if (decoded === null) return;
    if (decoded.global.copy.lastCopyTime !== undefined) {
      globalCopyState.lastCopyTime = decoded.global.copy.lastCopyTime;
    }
    if (decoded.global.copy.copiedUser !== null) {
      adoptCopyTarget(decoded.global.copy.copiedUser, decoded.global.copy.copyMode, decoded.global.copy.copyChatId!);
    }
    // 直接整块赋值：缺字段就是 undefined，那是「从没设过」，不是「沿用上次」。
    globalAssetState.fortuneThumbnailUrl = decoded.global.assets.fortuneThumbnailUrl;
    globalAssetState.probabilityThumbnailUrl = decoded.global.assets.probabilityThumbnailUrl;
    globalAssetState.gagThumbnailUrl = decoded.global.assets.gagThumbnailUrl;
    globalAssetState.botDefaultAvatarUrl = decoded.global.assets.botDefaultAvatarUrl;
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
    throw error;
  }
}

/**
 * 把 `state.global.assets` 里没设过的项补成内置常量，并在确有补写时落一次盘。
 *
 * 目的是**让旋钮出现在文件里**：这一块没有任何命令会写，改图的人得直接编辑
 * state.json；而缺省语义（缺字段=回退常量）意味着一个从没配过的部署里根本看不到
 * 这些键，于是要么去翻代码找键名，要么照着别处抄一份可能已经过时的示例。启动时
 * 补齐之后，文件里永远摆着四个当前生效的值，改图就是就地改。
 *
 * 只补缺的那一项：已经配过的值原样保留，绝不用常量覆盖部署方写下的地址。
 *
 * 落盘走 saveGlobalStateInBackground 而不是 persistGlobalState：这是一次为了
 * 可读性做的补写，不是谁按下的权威决策，写失败不该拦住启动——失败会照常走
 * StateStore 的重试与 fatal 通道（见 app/lifecycle.ts 的 setStatePersistenceFatalHandler）。
 * @returns 本次补写了几项；四项都配过时为 0，且不产生任何写盘。
 */
export function seedMissingAssetState(): number {
  let seeded: number = 0;
  if (globalAssetState.fortuneThumbnailUrl === undefined) {
    globalAssetState.fortuneThumbnailUrl = FORTUNE_THUMBNAIL_URL;
    seeded++;
  }
  if (globalAssetState.probabilityThumbnailUrl === undefined) {
    globalAssetState.probabilityThumbnailUrl = PROBABILITY_THUMBNAIL_URL;
    seeded++;
  }
  if (globalAssetState.gagThumbnailUrl === undefined) {
    globalAssetState.gagThumbnailUrl = GAG_THUMBNAIL_URL;
    seeded++;
  }
  if (globalAssetState.botDefaultAvatarUrl === undefined) {
    globalAssetState.botDefaultAvatarUrl = BOT_DEFAULT_AVATAR_URL;
    seeded++;
  }
  if (seeded > 0) saveGlobalStateInBackground("seed default asset URLs");
  return seeded;
}

function currentGlobalState(): StateFileSchema {
  return { global: { copy: globalCopyState, assets: globalAssetState } };
}

/**
 * 全局状态的 durability barrier。值在调用同步栈内完成序列化，
 * 返回的 Promise 只会在对应 revision（或更新 revision）主、备两份都落盘后完成。
 */
export async function persistGlobalState(context: string): Promise<void> {
  throwIfUpdateAborted();
  try {
    await sharedStateStore().save(currentGlobalState());
    throwIfUpdateAborted();
  } catch (error: unknown) {
    throwIfUpdateAborted();
    const reason: Error = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to persist global state update (${context}): ${reason.message}`, { cause: error });
  }
}

export function setStatePersistenceFatalHandler(handler: ((error: Error) => void) | undefined): void {
  sharedStateStore().setFatalHandler(handler);
}

export function saveGlobalStateInBackground(context: string): void {
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
 * 只读地查一个群的状态。没有条目时返回全局共享的 `DEFAULT_CHAT_STATE`，因此
 * 返回类型必须是 `Readonly<ChatState>`：写成可变的 `ChatState` 等于在类型层面
 * 把那个共享单例交出去（TS 的 `readonly` 不参与可赋值性判定，声明成
 * `Readonly<ChatState>` 的常量在这个边界会被静默放宽回可变），一次误写就污染
 * 所有没有状态的群。要修改状态的调用方一律走 `getOrCreateChatState`。
 *
 * 取值走 `peek` 而不是 `get`：后者命中时会 `Map.delete` + `Map.set` 把条目挪到
 * 迭代序最新一端，也就是**全仓最热的那个读会改写缓存**。而这份缓存的容量恰好是
 * STATE_MANAGED_CHAT_LIMIT，`getOrCreateChatState` 与 `hydrateChatStateCache` 又都在
 * 入口处拒绝第 26 条（见 infra/chatStateStorage.ts 的 assertChatStateCapacity），
 * 淘汰分支永远走不到——这次热度刷新一分钱也买不到，却要为它付 `Map` 的删+插：
 * chat-state-map-read 场景实测 **253.0 → 14.1 ns/op**（Bun 1.3.14，10M 次取值，
 * 各 7 个样本，两簇完全不重叠）。每条群消息要读 4~6 次（见 libs/chatState.ts 的
 * 形状契约），外加 ensureBotChatPermissions 与 botCanDeleteMessagesIn。
 *
 * 另一半理由是迭代序：`getChatStateCache()` 有十余处在迭代（/block、/unblock 的连带
 * 封禁群清单、各处 managed 群清扫、lockdown 收养与恢复……），用 `get` 会让它变成
 * 「读历史的函数」，其中两处直接呈现给用户。
 */
export function getChatState(chatId: number): Readonly<ChatState> {
  return chatStateCache.peek(chatId) ?? DEFAULT_CHAT_STATE;
}

export function getOrCreateChatState(chatId: number): ChatState {
  let chatState: ChatState | undefined = chatStateCache.peek(chatId);
  if (!chatState) {
    assertChatStateCapacity(chatId);
    // 规范形状一次建好；写入方只赋值，不往裸 `{}` 上一个个加字段（见
    // libs/chatState.ts 的 createChatState）。
    chatState = createChatState();
    chatStateCache.set(chatId, chatState);
  }
  return chatState;
}

export function clearChatStateField(chatId: number, field: keyof ChatState): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  // 判「有没有设过」看取值而不是 `field in chatState`：规范形状下键一直都在。
  if (chatState?.[field] === undefined) return false;
  chatState[field] = undefined;
  normalizeChatState(chatState);
  if (isEmptyChatState(chatState)) chatStateCache.delete(chatId);
  return true;
}

/**
 * 机器人离群时删除普通配置，但保留尚需恢复的 lockdown write-ahead 记录。
 * 无记录时不做任何事；调用方负责在同一 teardown 尾部统一落盘。
 */
export function pruneDepartedChatState(chatId: number): void {
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
