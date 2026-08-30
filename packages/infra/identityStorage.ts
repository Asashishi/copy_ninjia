/**
 * 主线程身份策略门面：同步热读、批量冷读、write-through、ACK 重放与分页补扫。
 * 具体职责拆在 identityStorage/ 叶子中，调用方继续只依赖这一处公开边界。
 */

export {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  hydrateIdentityStorageCounts,
  identityMetadataFromCachedUser,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
} from "./identityStorage/read";
export {
  confirmIdentityPolicyPersisted,
  queueIdentityPolicyWrite,
  requeueUnacknowledgedIdentityWrite,
} from "./identityStorage/write";
export {
  hasAnyBlockedIdentity,
  readBlocklistSweepPage,
  retainCurrentlyBlockedIdentityIds,
} from "./identityStorage/sweep";
