/** owner: main。state 权威存储（packages/infra/storage/stateStore.ts）的内存状态。 */

import type { StateStore } from "../../infra/storage/statePersistence";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type { GlobalCopyState } from "../../types/chatState";

/**
 * 进程唯一 StateStore 的惰性 holder。首次经 infra/storage/stateStore.ts 门面访问时创建（启动时
 * 登记致命处理器即是第一次），应用生命周期结束后对象保持 quiesced 直到进程退出；新进程从空 holder
 * 创建全新 writer。
 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * 全局 copy 权威内存镜像。启动恢复时填充，copy 命令更新；进程重启后从
 * memory/global/state.json 恢复，容量固定为一个对象。
 *
 * 各字段在创建时一次写齐（取值可为 undefined），此后只赋值不增删键，对象 shape 保持稳定
 * （activeCopyTargetIdIn 在每条群消息和每次反应更新上读取，见 infra/storage/stateStore.ts）。
 * `JSON.stringify` 丢弃 undefined，写齐键不改变状态文件的内容。
 * 三元组（copiedUser / copyMode / copyChatId）整体写入，读取方按
 * `copiedUser === null || copyChatId !== chatId` 判定。唯一的两个写入边界是
 * stateStore.ts 的 adoptCopyTarget 与 clearCopyTarget。
 */
export const globalCopyState: GlobalCopyState = {
  lastCopyTime: undefined,
  copiedUser: null,
  copyMode: undefined,
  copyChatId: undefined,
};

/**
 * 全局状态 `ttsUsage` 的窗口与各项独立计数的持久化镜像；权威值在 AI Worker（cache/workers/aiChat/ttsUsage.ts）。
 *
 * 启动恢复时从 memory/global/state.json 填充（缺省为 null，表示从没用过），此后每收到一次
 * Worker 的 ttsUsage 回执就整体替换为那一份全量计数（退还到两项皆 0 时为 null）并在后台落盘（见
 * infra/storage/stateStore.ts 的 adoptTtsUsage）。主线程只读它来落盘与重放：AI Worker
 * 启动时在 init 之后投递、崩溃重建时由 aiChat/workerBridge.ts 的 onRespawn 重放
 * hydrateTtsUsage。null 表示没有任何计数，Worker 按从没用过处理。容量恒为一个对象。
 */
export const globalTtsUsageState: { current: TtsDailyUsage | null } = { current: null };
