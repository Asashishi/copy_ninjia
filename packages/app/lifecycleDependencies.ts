import { flushAiMemory, hydrateAiMemory, hydrateStickerCatalog, initAiChat, terminateAiChat } from "../aiChat";
import { drainAntiRaid, hydratePendingVerifications, initAntiRaid, terminateAntiRaid } from "../antiRaid";
import { hydrateBlocklist } from "../infra/blocklist/outbox";
import { assertSuperAdminNotBlocked } from "../infra/blocklist/membership";
import {
  initBlocklistSweepScheduler,
  quiesceBlocklistSweepScheduler,
  sweepManagedBlocklistChats,
} from "../infra/blocklist/sweep";
import { restoreLuckState } from "../commands";
import {
  drainGagRuntime,
  initGagRuntime,
  quiesceGagRuntime,
} from "../commands/gag/runtime";
import { drainAvatarUpdates, initAvatarUpdates, quiesceAvatarUpdates } from "../copy/avatarQueue";
import { drainReactionQueue, initReactionQueue, quiesceReactionQueue } from "../copy/reactionQueue";
import { closeTranslate, drainTranslate, initTranslate, quiesceTranslate } from "../copy/translate";
import {
  abortChatTitleRefresh,
  initChatTitleRefresh,
  quiesceChatTitleRefresh,
  refreshAllChatTitles,
} from "../infra/chatTitle";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../config/telegram";
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
  seedMissingAssetState,
  setStatePersistenceFatalHandler,
} from "../infra/storage/stateStore";
import {
  drainPendingMessageDeletions,
} from "../infra/telegram";
import { drainTelegramOutbound } from "../infra/telegram/outboundGate";
import { bot, initTelegramClients } from "../infra/telegram/mainClient";
import { sleep } from "../libs/sleep";
import { monotonicNow } from "../libs/monotonicDeadline";
import { seedSenderCache } from "../users/senderIdentity";
import { preflightEnabledFeatures } from "./featurePreflight";
import { hydrateIdentityStorageCounts } from "../infra/identityStorage";
import { registerCommandMenu } from "./commandMenu";
import { registerHandlers } from "./registerHandlers";
import { runAcknowledgedUpdateBatches } from "./updateRunner";

/**
 * 应用生命周期的副作用边界。
 *
 * 普通对象刻意不使用直接 re-export：Bun 的模块 mock 会追溯重绑定 re-export，
 * 从而把测试替身泄漏到 diskIO 等原始模块。对象快照让替换严格停留在本边界。
 */
// 类型侧的 ApplicationLifecycleDependencies 由本装配对象反推；这里再写标注会成环。
// eslint-disable-next-line @typescript-eslint/typedef -- 标注会与 typeof 推导成环
export const lifecycleDependencies = {
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID,
  abortChatTitleRefresh,
  acquireSingleInstanceLock,
  assertSuperAdminNotBlocked,
  bot,
  cleanupOrphanedTempFiles,
  closeTranslate,
  drainAntiRaid,
  drainAvatarUpdates,
  drainGagRuntime,
  drainReactionQueue,
  drainPendingMessageDeletions,
  drainTelegramOutbound,
  drainTranslate,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  hydrateIdentityStorageCounts,
  hydrateAiMemory,
  hydrateBlocklist,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAvatarUpdates,
  initGagRuntime,
  initAiChat,
  initAntiRaid,
  initBlocklistSweepScheduler,
  initChatTitleRefresh,
  initDiskIO,
  initReactionQueue,
  initTranslate,
  initTelegramClients,
  loadPersistedData,
  loadState,
  logger,
  monotonicNow,
  preflightEnabledFeatures,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runAcknowledgedUpdateBatches,
  seedMissingAssetState,
  quiesceAvatarUpdates,
  quiesceChatTitleRefresh,
  quiesceReactionQueue,
  quiesceGagRuntime,
  quiesceBlocklistSweepScheduler,
  quiesceTranslate,
  seedSenderCache,
  setBusinessWorkerFatalHandler,
  setStatePersistenceFatalHandler,
  sleep,
  sweepManagedBlocklistChats,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
};

/** 应用生命周期的完整副作用依赖；测试通过构造器注入替身。 */
export type ApplicationLifecycleDependencies = typeof lifecycleDependencies;
