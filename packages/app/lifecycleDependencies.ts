import { flushAiMemory, hydrateAiMemory, hydrateStickerCatalog, initAiChat, terminateAiChat } from "../aiChat";
import { drainAntiRaid, hydratePendingVerifications, initAntiRaid, terminateAntiRaid } from "../antiRaid";
import { hydrateBlocklist } from "../infra/blocklist";
import { restoreLuckState } from "../commands";
import { drainAvatarUpdates, initAvatarUpdates, quiesceAvatarUpdates } from "../copy/avatarQueue";
import { drainReactionQueue, initReactionQueue, quiesceReactionQueue } from "../copy/reactionQueue";
import { closeTranslate, drainTranslate, initTranslate, quiesceTranslate } from "../copy/translate";
import {
  abortChatTitleRefresh,
  initChatTitleRefresh,
  quiesceChatTitleRefresh,
  refreshAllChatTitles,
} from "../infra/chatTitle";
import { BOT_TOKEN } from "../infra/config";
import { flushDiskIO, initDiskIO, loadPersistedData, terminateDiskIO } from "../infra/diskIO";
import { logger } from "../infra/logger";
import { setBusinessWorkerFatalHandler } from "../infra/workerSupervisor";
import { cleanupOrphanedTempFiles } from "../infra/storage/cleanup";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../infra/storage/instanceLock";
import {
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  loadState,
  setStatePersistenceFatalHandler,
} from "../infra/storage/stateStore";
import { bot, initTelegramClients } from "../infra/telegram";
import { sleep } from "../libs/sleep";
import { seedSenderCache } from "../users/senderIdentity";
import { preflightEnabledFeatures } from "./featurePreflight";
import { registerCommandMenu } from "./commandMenu";
import { registerHandlers } from "./registerHandlers";
import { runAcknowledgedUpdateBatches } from "./updateRunner";

/**
 * 应用生命周期的副作用边界。
 *
 * 普通对象刻意不使用直接 re-export：Bun 的模块 mock 会追溯重绑定 re-export，
 * 从而把测试替身泄漏到 diskIO 等原始模块。对象快照让替换严格停留在本边界。
 */
// 类型侧的 ApplicationLifecycleDependencies 是 `typeof lifecycleDependencies`
// 反推出来的（见 types/lifecycle.ts），这里再写标注会成环。
// eslint-disable-next-line @typescript-eslint/typedef -- 标注会与 typeof 推导成环
export const lifecycleDependencies = {
  BOT_TOKEN,
  abortChatTitleRefresh,
  acquireSingleInstanceLock,
  bot,
  cleanupOrphanedTempFiles,
  closeTranslate,
  drainAntiRaid,
  drainAvatarUpdates,
  drainReactionQueue,
  drainTranslate,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  hydrateAiMemory,
  hydrateBlocklist,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAvatarUpdates,
  initAiChat,
  initAntiRaid,
  initChatTitleRefresh,
  initDiskIO,
  initReactionQueue,
  initTranslate,
  initTelegramClients,
  loadPersistedData,
  loadState,
  logger,
  preflightEnabledFeatures,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runAcknowledgedUpdateBatches,
  quiesceAvatarUpdates,
  quiesceChatTitleRefresh,
  quiesceReactionQueue,
  quiesceTranslate,
  seedSenderCache,
  setBusinessWorkerFatalHandler,
  setStatePersistenceFatalHandler,
  sleep,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
};
