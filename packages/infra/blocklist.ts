/**
 * /block 主线程基础设施的兼容门面。
 *
 * - membership：同步名单、命令侧确证缓存与名单落盘确认；
 * - outbox：durable 群级处置任务的恢复、编号、裁剪与交付；
 * - sweep：补扫退避、权限闩锁、回执结算与业务 Worker 重放。
 *
 * 生产调用方继续从本文件导入，领域 owner 之间则直接引用对应子模块，避免重新
 * 形成单个高耦合入口。
 */

export {
  blockUser,
  confirmBlocklistPersisted,
  ensureBlocklistEntryQueued,
  forgetUserConfirmedKicked,
  isUserBlocked,
  isUserConfiguredBlocked,
  recordUserConfirmedKickedInChat,
  unblockUser,
  wasUserConfirmedKickedInChat,
} from "./blocklist/membership";
export {
  dispatchBlockedRemovals,
  forgetChatBlocklistWork,
  getPendingBlockedRemovalParams,
  hydrateBlocklist,
  persistPendingBlockedRemovals,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} from "./blocklist/outbox";
export {
  noteBanPermissionObserved,
  replayPendingBlockedRemovals,
  requestBlocklistResweep,
  settleBlockedRemoval,
  sweepManagedBlocklistChats,
  sweepBlockedMembers,
} from "./blocklist/sweep";
