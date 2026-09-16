import { chatQa } from "./chatQa";
import { chatStates } from "./chatState";
import { blocklistEntries, permissionList } from "./identityPolicy";
import { storageMetadata } from "./metadata";
import { pendingBlockedRemovals } from "./pendingRemoval";
import { temporaryAdBypassEntries } from "./temporaryAdBypass";

/** Drizzle 连接使用的完整共享存储 schema；各领域表声明仍保持独立。 */
export const storageDatabaseSchema: Readonly<{
  permissionList: typeof permissionList;
  blocklistEntries: typeof blocklistEntries;
  pendingBlockedRemovals: typeof pendingBlockedRemovals;
  chatStates: typeof chatStates;
  chatQa: typeof chatQa;
  temporaryAdBypassEntries: typeof temporaryAdBypassEntries;
  storageMetadata: typeof storageMetadata;
}> = {
  permissionList,
  blocklistEntries,
  pendingBlockedRemovals,
  chatStates,
  chatQa,
  temporaryAdBypassEntries,
  storageMetadata,
};
