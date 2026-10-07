/** Anti-Raid 待验证增量 JSON 的合并与防御边界。 */

import { DAY_FILE_JSON_INDENT } from "./appendOnly";

/** 当前待验证日文件记录版本；结构变化只接受手工迁移后的新版本。 */
export const VERIFICATION_FILE_VERSION: number = 2;
/** 匹配按约定缩进序列化的顶层 JSON 条目，用于统计追加历史。 */
export const VERIFICATION_TOP_LEVEL_ENTRY_PATTERN: RegExp = new RegExp(
  `^${" ".repeat(DAY_FILE_JSON_INDENT)}"(?:[^"\\\\]|\\\\.)+":`,
  "gm"
);

/** 午夜轮换失败后的固定重试间隔；正常每日触发由统一维护 cron 负责。 */
export const VERIFICATION_ROLLOVER_RETRY_MS: number = 1_000;
/**
 * 跨日整理或收敛时，同一份最新旧日文件连续解码失败达到这个次数，就把它改名为损坏文件
 * （见 VERIFICATION_CORRUPT_DAY_FILE_SUFFIX），新的一天直接按 active 镜像写入。
 * 所属模块：workers/diskIO/verificationRecovery.ts。
 */
export const VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS: number = 3;
/**
 * 损坏旧日文件改名时追加的后缀：`<YYYY-MM-DD>.json` 改为 `<YYYY-MM-DD>.json.corrupt`。改名后不再以
 * `.json` 结尾，启动恢复与旧日清理都不读也不删它，原样留给人工排查。所属模块：
 * workers/diskIO/verificationRecovery.ts。
 */
export const VERIFICATION_CORRUPT_DAY_FILE_SUFFIX: string = ".corrupt";
/** 追加条数或字节达到任一阈值时收敛为 active 快照（字节阈值见 VERIFICATION_FILE_COMPACT_BYTES）。 */
export const VERIFICATION_FILE_COMPACT_ENTRIES: number = 10_000;
/** 待验证当日文件触发 active 快照收敛的字节阈值。 */
export const VERIFICATION_FILE_COMPACT_BYTES: number = 4 * 1024 * 1024;
/**
 * 快照 label 字段的防御性长度上限，只用于拒绝损坏/篡改文件，不代表业务预期长度。
 */
export const VERIFICATION_LABEL_MAX_CHARS: number = 512;

/**
 * 各阶段待验证记录共同允许的字段；codec 只读查表，不为每条恢复记录重建 Set。
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
