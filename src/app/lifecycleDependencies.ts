import { flushAiMemory, hydrateAiMemory, hydrateStickerCatalog, initAiChat, terminateAiChat } from "../aiChat";
import { drainAntiRaid, hydratePendingVerifications, initAntiRaid, terminateAntiRaid } from "../antiRaid";
import { restoreLuckState } from "../commands";
import { getMoodConfig } from "../config/mood";
import { getReactionConfig } from "../config/reactions";
import { getStickerConfig } from "../config/stickers";
import { drainAvatarUpdates } from "../copy/avatarQueue";
import { drainReactionQueue } from "../copy/reactionQueue";
import { refreshAllChatTitles } from "../infra/chatTitle";
import { BOT_TOKEN } from "../infra/config";
import { flushDiskIO, initDiskIO, loadPersistedData, terminateDiskIO } from "../infra/diskIO";
import { logger } from "../infra/logger";
import { cleanupOrphanedTempFiles } from "../infra/storage/cleanup";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../infra/storage/instanceLock";
import { flushStateToDisk, getAllChatStates, getGlobalCopyState, loadState } from "../infra/storage/stateStore";
import { bot, initTelegramClients } from "../infra/telegram";
import { sleep } from "../libs/sleep";
import { seedSenderCache } from "../users/senderIdentity";
import { registerCommandMenu } from "./commandMenu";
import { registerHandlers } from "./registerHandlers";
import { runAcknowledgedUpdateBatches } from "./updateRunner";

/**
 * 应用生命周期的副作用边界。
 *
 * 普通对象刻意不使用直接 re-export：Bun 的模块 mock 会追溯重绑定 re-export，
 * 从而把测试替身泄漏到 diskIO 等原始模块。对象快照让替换严格停留在本边界。
 */
export const lifecycleDependencies = {
  BOT_TOKEN,
  acquireSingleInstanceLock,
  bot,
  cleanupOrphanedTempFiles,
  drainAntiRaid,
  drainAvatarUpdates,
  drainReactionQueue,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getAllChatStates,
  getGlobalCopyState,
  getMoodConfig,
  getReactionConfig,
  getStickerConfig,
  hydrateAiMemory,
  hydratePendingVerifications,
  hydrateStickerCatalog,
  initAiChat,
  initAntiRaid,
  initDiskIO,
  initTelegramClients,
  loadPersistedData,
  loadState,
  logger,
  refreshAllChatTitles,
  registerCommandMenu,
  registerHandlers,
  releaseSingleInstanceLock,
  restoreLuckState,
  runAcknowledgedUpdateBatches,
  seedSenderCache,
  sleep,
  terminateAiChat,
  terminateAntiRaid,
  terminateDiskIO,
};
