import type { StateStore } from "../../infra/storage/statePersistence";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type { GlobalCopyState } from "../../types/chatState";

/** owner: main。state 权威存储（packages/infra/storage/stateStore.ts）的内存状态。 */

/**
 * 进程唯一 StateStore 的惰性 holder。首次持久化操作时填充，应用生命周期
 * 结束后对象保持 quiesced 直到进程退出；新进程从空 holder 创建全新 writer。
 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * 全局 copy 权威内存镜像。启动恢复时填充，copy 命令更新；进程重建时从
 * memory/global/state.json 恢复，容量固定为一个对象。
 *
 * 四个字段在创建时一次写齐（哪怕都是 undefined），此后只赋值不增删键：
 * activeCopyTargetIdIn 跑在每条群消息和每次反应更新上（见
 * infra/storage/stateStore.ts），shape 不该在 /copy 或 loadState 之后再变一次。
 * `JSON.stringify` 丢弃 undefined，因此写齐键不会改变状态文件的内容。
 * 三元组（copiedUser / copyMode / copyChatId）必须整体写：读取方按
 * `copiedUser === null || copyChatId !== chatId` 判定，拆开写会出现「有目标但
 * 还没记群」的中间态。唯一的两个写入边界是 stateStore.ts 的 adoptCopyTarget 与
 * clearCopyTarget。
 */
export const globalCopyState: GlobalCopyState = {
  lastCopyTime: undefined,
  copiedUser: null,
  copyMode: undefined,
  copyChatId: undefined,
};

/**
 * 全局状态 `ttsUsage` 的持久化镜像；权威值在 AI Worker（cache/workers/aiChat/ttsUsage.ts）。
 *
 * 启动恢复时从 memory/global/state.json 填充（缺省为 null，表示从没用过），此后每收到一次
 * Worker 的 ttsUsage 回执就整体替换为那一份全量计数并在后台落盘（见
 * infra/storage/stateStore.ts 的 adoptTtsUsage）。主线程只读它来落盘与重放：AI Worker
 * 启动时在 init 之后投递、崩溃重建时由 aiChat/workerBridge.ts 的 onRespawn 重放
 * hydrateTtsUsage。null 表示没有任何计数，Worker 按从没用过处理。容量恒为一个对象。
 */
export const globalTtsUsageState: { current: TtsDailyUsage | null } = { current: null };
