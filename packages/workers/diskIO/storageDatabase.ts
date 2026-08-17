/**
 * Disk I/O Worker 的共享 SQLite 门面。
 *
 * 连接恢复、群状态、身份策略、待踢 outbox 与统一事务提交分别由同名子目录模块
 * 实现；本文件只稳定消息路由所需的公开入口，不持有状态或复制领域逻辑。
 */

export { handleChatStateWrite } from "./storageDatabase/chatState";
export {
  configureStoragePersistenceReply,
  flushStorageDatabase,
  pendingStorageDatabaseDomains,
} from "./storageDatabase/flush";
export { hydrateStorageDatabase } from "./storageDatabase/hydration";
export {
  handleIdentityPolicyWrite,
  readBlocklistIdPage,
  readIdentityPolicies,
} from "./storageDatabase/identityPolicy";
export { handlePendingRemovalSnapshot } from "./storageDatabase/pendingRemoval";
