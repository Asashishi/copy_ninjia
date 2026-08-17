/** Anti-Raid 待验证增量 JSON 的合并与防御边界。 */

import { DAY_FILE_JSON_INDENT } from "./appendOnly";

/** 当前待验证日文件记录版本；结构变化只接受手工迁移后的新版本。 */
export const VERIFICATION_FILE_VERSION: number = 2;
/** 东京标准时相对 UTC 的固定毫秒偏移，用于计算下一次本地午夜。 */
export const TOKYO_OFFSET_MS: number = 9 * 60 * 60 * 1_000;
/** 匹配按约定缩进序列化的顶层 JSON 条目，用于统计追加历史。 */
export const VERIFICATION_TOP_LEVEL_ENTRY_PATTERN: RegExp = new RegExp(
  `^${" ".repeat(DAY_FILE_JSON_INDENT)}"(?:[^"\\\\]|\\\\.)+":`,
  "gm"
);

/** 普通状态/提醒回填变化的短合并窗口；创建与终结立即追加。 */
export const VERIFICATION_FLUSH_INTERVAL_MS: number = 250;
/** 单次验证增量合并达到后立即刷盘的 key 数阈值。 */
export const VERIFICATION_FLUSH_MAX_KEYS: number = 100;
/** 重复历史达到任一阈值前收敛为 active 快照，避免当天文件无限增长。 */
export const VERIFICATION_FILE_COMPACT_ENTRIES: number = 10_000;
/** 待验证当日文件触发 active 快照收敛的字节阈值。 */
export const VERIFICATION_FILE_COMPACT_BYTES: number = 4 * 1024 * 1024;
/**
 * 快照 label 字段的防御性长度上限。正常取值来自 Telegram username（≤32）、
 * first_name（≤64）或频道标题（≤128），远小于此值；这里只用于拒绝损坏/篡改
 * 文件，不代表业务预期长度。
 */
export const VERIFICATION_LABEL_MAX_CHARS: number = 512;

/**
 * 四种待验证记录共同允许的字段；codec 只读查表，不为每条恢复记录重建 Set。
 * 所属模块：workers/diskIO/verificationCodec.ts。
 */
export const VERIFICATION_BASE_RECORD_KEYS: ReadonlySet<string> = new Set([
  "version", "chatId", "userId", "generation", "revision", "phase", "label",
  "isBot", "announcementMessageId", "trackedMessageTimes", "invitedBy",
  "reminderMessageId", "replyReminderMessageId", "replyReminderRequested",
  "welcomeAnchorMessageId", "reminderSuperseded", "joinedAt", "expiresAt",
]);

/** kickPending 记录在公共字段之外允许的阶段字段。所属模块：workers/diskIO/verificationCodec.ts。 */
export const VERIFICATION_KICK_PENDING_RECORD_KEYS: ReadonlySet<string> = new Set([
  ...VERIFICATION_BASE_RECORD_KEYS,
  "requestedAt",
  "countedJoinAt",
]);

/** checkingInviter 记录在公共字段之外允许的阶段字段。所属模块：workers/diskIO/verificationCodec.ts。 */
export const VERIFICATION_CHECKING_INVITER_RECORD_KEYS: ReadonlySet<string> = new Set([
  ...VERIFICATION_BASE_RECORD_KEYS,
  "terminalInviterId",
]);

/** expelling 记录在公共字段之外允许的阶段字段。所属模块：workers/diskIO/verificationCodec.ts。 */
export const VERIFICATION_EXPELLING_RECORD_KEYS: ReadonlySet<string> = new Set([
  ...VERIFICATION_BASE_RECORD_KEYS,
  "expelReason",
  "successNoticeSent",
  "failureNoticeSent",
  "unconfirmedNoticeSent",
  "removalConfirmed",
]);
