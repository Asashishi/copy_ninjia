import type { BotImageOrigin } from "../../types/aiChat/memory";

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

/** AI 逐字记忆的单行字段不得含普通空格以外的空白，包括 NEL。 */
export const AI_MEMORY_NON_SPACE_WHITESPACE_PATTERN: RegExp = /[^\S ]|\u0085/u;

/** AI 逐字记忆的东京本地时间形态；日历有效性由 decoder 按当前格式校验。 */
export const AI_MEMORY_TIME_PATTERN: RegExp = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;

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
  "pendingImage",
];

/** AI 持久化逐字消息里占位态图片（pendingImage）的字段闭集。 */
export const PENDING_BOT_IMAGE_KEYS: readonly string[] = [
  "origin",
  "caption",
];

/** 占位态图片来源（PendingBotImage.origin）的取值闭集；决定回填时使用的自录记号。 */
export const BOT_IMAGE_ORIGINS: readonly BotImageOrigin[] = [
  "command",
  "generated",
  "referenceGenerated",
];

/** AI 记忆快照的顶层字段闭集。 */
export const AI_MEMORY_SNAPSHOT_KEYS: readonly string[] = [
  "version",
  "buffer",
  "summaries",
  "pendingSummary",
  "savedAt",
];
