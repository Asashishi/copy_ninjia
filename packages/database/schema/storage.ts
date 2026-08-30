import { chatQa } from "./chatQa";
import { chatStates } from "./chatState";
import { blocklistEntries, whitelistEntries } from "./identityPolicy";
import { storageMetadata } from "./metadata";
import { pendingBlockedRemovals } from "./pendingRemoval";
import { temporaryWhitelistEntries } from "./temporaryWhitelist";

/** Drizzle 连接使用的完整共享存储 schema；各领域表声明仍保持独立。 */
export const storageDatabaseSchema: Readonly<{
  whitelistEntries: typeof whitelistEntries;
  blocklistEntries: typeof blocklistEntries;
  pendingBlockedRemovals: typeof pendingBlockedRemovals;
  chatStates: typeof chatStates;
  chatQa: typeof chatQa;
  temporaryWhitelistEntries: typeof temporaryWhitelistEntries;
  storageMetadata: typeof storageMetadata;
}> = {
  whitelistEntries,
  blocklistEntries,
  pendingBlockedRemovals,
  chatStates,
  chatQa,
  temporaryWhitelistEntries,
  storageMetadata,
};
