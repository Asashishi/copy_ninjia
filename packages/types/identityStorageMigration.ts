import type { PendingBlockedRemoval } from "./blocklist";
import type { WhitelistPermissions } from "./identityPolicy";

/** 旧静态黑名单文件严格解码后的唯一字段。 */
export interface LegacyBlocklistConfig {
  readonly blockedIds: readonly number[];
}

/** 旧白名单 ID 到完整权限的严格解码结果。 */
export type LegacyWhitelistConfig = ReadonlyMap<
  number,
  Readonly<WhitelistPermissions>
>;

/** 三份旧结构严格合并后的迁移输入。 */
export interface MigrationInput {
  readonly whitelist: LegacyWhitelistConfig;
  readonly blockedIds: readonly number[];
  readonly removals: Map<number, PendingBlockedRemoval>;
}
