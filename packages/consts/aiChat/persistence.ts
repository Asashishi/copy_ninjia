/** AI 持久化回复引用的字段闭集。 */
export const BUFFERED_REPLY_REFERENCE_KEYS: readonly string[] = [
  "id",
  "firstName",
  "lastName",
  "username",
  "messageId",
  "text",
  "quote",
  "forwardedFrom",
];

/** AI 持久化逐字消息的字段闭集。 */
export const BUFFERED_MESSAGE_KEYS: readonly string[] = [
  "id",
  "firstName",
  "lastName",
  "username",
  "messageId",
  "text",
  "replyTo",
  "forwardedFrom",
  "at",
];

/** AI 记忆快照的顶层字段闭集。 */
export const AI_MEMORY_SNAPSHOT_KEYS: readonly string[] = [
  "version",
  "buffer",
  "summaries",
  "pendingSummary",
  "savedAt",
];
