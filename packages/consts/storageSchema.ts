/** 身份元数据持久化字段闭集，用于严格解析。 */
export const IDENTITY_META_KEYS: readonly string[] = [
  "firstName",
  "lastName",
  "username",
];

/** 白名单数据持久化字段闭集，用于严格解析。 */
export const WHITELIST_DATA_KEYS: readonly string[] = ["permissions", "meta"];

/** 黑名单数据持久化字段闭集，用于严格解析；`participantInvalidCount` 可缺省。 */
export const BLOCKLIST_DATA_KEYS: readonly string[] = [
  "blockedAt",
  "meta",
  "participantInvalidCount",
];

/** 群状态持久化字段闭集，用于拒绝未知字段。 */
export const CHAT_STATE_KEYS: readonly string[] = [
  "quietUntil",
  "lockdown",
  "isAIChatEnabled",
  "isTranslationEnabled",
  "isAdDetectEnabled",
  "isFloodControlEnabled",
  "isAntiRaidEnabled",
  "isInitEnabled",
  "botPermissions",
  "title",
  "isProxySendEnabled",
  "translate",
];

/** 群状态里一条翻译会话的字段闭集（database/codec/chatState.ts 严格解析用）。 */
export const TRANSLATE_SESSION_KEYS: readonly string[] = ["translatedUser", "language"];

/** 持久化目标身份（复读目标、翻译目标）的字段闭集（libs/cachedUserCodec.ts 严格解析用）。 */
export const CACHED_USER_KEYS: readonly string[] = [
  "id",
  "username",
  "first_name",
  "last_name",
  "title",
  "isChannel",
];

/** 群锁定状态持久化字段闭集，用于严格解析。 */
export const LOCKDOWN_KEYS: readonly string[] = [
  "phase",
  "intentId",
  "originalPermissions",
  "announced",
  "announcementMessageId",
  "expiresAt",
];

/** 群问答持久化字段闭集，用于严格解析。 */
export const CHAT_QA_DATA_KEYS: readonly string[] = ["a"];
