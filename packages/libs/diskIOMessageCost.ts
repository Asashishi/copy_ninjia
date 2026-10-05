import { DISK_BUSINESS_MESSAGE_BASE_BYTES, DISK_JSON_STRING_UNIT_MAX_BYTES } from "../consts/diskIO/business";
import type { VerificationSnapshot } from "../types/antiRaid/verification";
import type { PendingBlockedRemoval, PendingBlockedRemovalParams } from "../types/blocklist";
import type {
  BlocklistRemovalsDiskMessage,
  DiskIOOperationMessage,
  DiskBusinessMessage,
  VerificationUpsertDiskMessage,
} from "../types/diskIO/messages";
import { jsonSerializedBytes } from "./jsonBytes";

/**
 * 联合类型各成员键的并集；结构上界模板据此必须列出每个可能出现的字段。模板只约束键齐全：
 * 整数字段填 LONGEST_SAFE_INTEGER、枚举填最长取值，字符串与数组字段在模板里留空，由
 * blocklistRemovalsMaxBytes / verificationUpsertMaxBytes 按实际长度单独计价，新增这类字段
 * 必须同时补上它的计价项。
 */
type AllKeys<T> = T extends unknown ? keyof T : never;

/** JSON 写法最长的安全整数（`-9007199254740991`），模板里的整数字段一律取它。 */
const LONGEST_SAFE_INTEGER: number = Number.MIN_SAFE_INTEGER;
/** 整数数组里一个元素的 JSON 上界：最长写法加分隔逗号。 */
const INTEGER_ELEMENT_MAX_BYTES: number = String(LONGEST_SAFE_INTEGER).length + 1;

/** JSON 里 `null` 的字节数；lastFailure 为字符串时改按其长度加两个引号计。 */
const JSON_NULL_BYTES: number = JSON.stringify(null).length;

/**
 * 待踢任务一行的 JSON 模板：外层 `[removalId, removal]` 加行间逗号，lastFailure 为 null，
 * 指名行的 userIds 为空；字段必须覆盖类型的全部键。
 */
function removalRowTemplateBytes(params: Readonly<Record<string, unknown>>): number {
  const removal: Readonly<Record<keyof PendingBlockedRemoval, unknown>> = {
    params,
    createdAt: LONGEST_SAFE_INTEGER,
    attempts: LONGEST_SAFE_INTEGER,
    lastFailure: null,
  };
  return JSON.stringify([LONGEST_SAFE_INTEGER, removal]).length + 1;
}

/** 指名待踢行 params 的上界模板：可选字段齐全，userIds 留空按元素另计。 */
const NAMED_REMOVAL_PARAMS_TEMPLATE: Readonly<Record<AllKeys<PendingBlockedRemovalParams>, unknown>> = {
  chatId: LONGEST_SAFE_INTEGER,
  probeMembership: false,
  userIds: [],
  removalId: LONGEST_SAFE_INTEGER,
  joinedAt: LONGEST_SAFE_INTEGER,
  announcementMessageId: LONGEST_SAFE_INTEGER,
};
/** 补扫行 params 的上界模板。 */
const PROBE_REMOVAL_PARAMS_TEMPLATE: Readonly<Record<keyof Extract<PendingBlockedRemovalParams, { probeMembership: true }>, unknown>> = {
  chatId: LONGEST_SAFE_INTEGER,
  probeMembership: true,
  removalId: LONGEST_SAFE_INTEGER,
};
/** blocklistRemovals 消息外壳的上界模板：removals 留空按行另计。 */
const REMOVALS_MESSAGE_TEMPLATE: Readonly<Record<keyof BlocklistRemovalsDiskMessage, unknown>> = {
  type: "blocklistRemovals",
  removals: [],
  revision: LONGEST_SAFE_INTEGER,
};
/**
 * 指名行除 userIds 元素与失败分类外的 JSON 字节上界（含行间逗号）：整数取最长写法、
 * 可选字段齐全。
 */
const NAMED_REMOVAL_ROW_MAX_BYTES: number = removalRowTemplateBytes(NAMED_REMOVAL_PARAMS_TEMPLATE);
/** 补扫行除失败分类外的 JSON 字节上界（含行间逗号）。 */
const PROBE_REMOVAL_ROW_MAX_BYTES: number = removalRowTemplateBytes(PROBE_REMOVAL_PARAMS_TEMPLATE);
/** blocklistRemovals 消息去掉各行后的 JSON 字节上界。 */
const REMOVALS_MESSAGE_MAX_BYTES: number = JSON.stringify(REMOVALS_MESSAGE_TEMPLATE).length;

/**
 * 验证快照的上界模板：各 phase 字段取并集、枚举取最长取值；label 与 trackedMessageTimes
 * 留空按实际长度另计。
 */
const VERIFICATION_SNAPSHOT_TEMPLATE: Readonly<Record<AllKeys<VerificationSnapshot>, unknown>> = {
  chatId: LONGEST_SAFE_INTEGER,
  userId: LONGEST_SAFE_INTEGER,
  generation: LONGEST_SAFE_INTEGER,
  revision: LONGEST_SAFE_INTEGER,
  label: "",
  isBot: false,
  announcementMessageId: LONGEST_SAFE_INTEGER,
  trackedMessageTimes: [],
  invitedBy: LONGEST_SAFE_INTEGER,
  reminderMessageId: LONGEST_SAFE_INTEGER,
  replyReminderMessageId: LONGEST_SAFE_INTEGER,
  replyReminderRequested: false,
  welcomeAnchorMessageId: LONGEST_SAFE_INTEGER,
  reminderSuperseded: false,
  joinedAt: LONGEST_SAFE_INTEGER,
  expiresAt: LONGEST_SAFE_INTEGER,
  phase: "checkingInviter",
  requestedAt: LONGEST_SAFE_INTEGER,
  countedJoinAt: LONGEST_SAFE_INTEGER,
  terminalInviterId: LONGEST_SAFE_INTEGER,
  expelReason: "timeout",
  successNoticeSent: false,
  failureNoticeSent: false,
  unconfirmedNoticeSent: false,
  removalConfirmed: false,
};
/** verificationUpsert 消息的上界模板。 */
const VERIFICATION_UPSERT_TEMPLATE: Readonly<Record<keyof VerificationUpsertDiskMessage, unknown>> = {
  type: "verificationUpsert",
  record: VERIFICATION_SNAPSHOT_TEMPLATE,
  critical: false,
};
/**
 * verificationUpsert 消息除 label 字符与 trackedMessageTimes 元素外的 JSON 字节上界：
 * 各 phase 的字段取并集，整数取最长写法，枚举取最长取值。
 */
const VERIFICATION_UPSERT_MAX_BYTES: number = JSON.stringify(VERIFICATION_UPSERT_TEMPLATE).length;

/** blocklistRemovals 的 JSON 字节上界；按行结构累加，不序列化整份快照。 */
function blocklistRemovalsMaxBytes(message: BlocklistRemovalsDiskMessage): number {
  let bytes: number = REMOVALS_MESSAGE_MAX_BYTES;
  for (const [, removal] of message.removals) {
    bytes += removal.params.probeMembership
      ? PROBE_REMOVAL_ROW_MAX_BYTES
      : NAMED_REMOVAL_ROW_MAX_BYTES + removal.params.userIds.length * INTEGER_ELEMENT_MAX_BYTES;
    if (removal.lastFailure !== null) bytes += removal.lastFailure.length + 2 - JSON_NULL_BYTES;
  }
  return bytes;
}

/** verificationUpsert 的 JSON 字节上界。 */
function verificationUpsertMaxBytes(message: VerificationUpsertDiskMessage): number {
  return VERIFICATION_UPSERT_MAX_BYTES +
    message.record.label.length * DISK_JSON_STRING_UNIT_MAX_BYTES +
    message.record.trackedMessageTimes.length * INTEGER_ELEMENT_MAX_BYTES;
}

/**
 * 队列中字符串与消息对象的保守成本；高频固定字段不重新序列化。outbox 快照与验证
 * 快照按结构算 JSON 字节上界，诊断批按实际序列化字节计。
 */
export function diskIOMessageCost(message: DiskIOOperationMessage): number {
  let payloadBytes: number = 0;
  switch (message.type) {
    case "aiMemory":
      payloadBytes = message.snapshot.length * 2;
      break;
    case "stickerCatalog":
      payloadBytes = (message.snapshot.length + message.pack.length) * 2;
      break;
    case "luckDraw":
      payloadBytes = (message.day.length + message.key.length + message.label.length) * 2;
      break;
    case "identityPolicyWrite":
    case "chatStateWrite":
      payloadBytes = (message.data?.length ?? 0) * 2;
      break;
    case "chatQaWrite":
      payloadBytes = (message.q.length + (message.data?.length ?? 0)) * 2;
      break;
    case "readIdentityPolicies":
      payloadBytes = message.ids.length * 8;
      break;
    case "wedMembers":
      payloadBytes = message.members.length * 8;
      break;
    case "blocklistRemovals":
      payloadBytes = blocklistRemovalsMaxBytes(message) * 2;
      break;
    case "verificationUpsert":
      payloadBytes = verificationUpsertMaxBytes(message) * 2;
      break;
    case "diagnosticBatch":
      payloadBytes = jsonSerializedBytes(message) * 2;
      break;
    case "load":
      payloadBytes = message.timeZone.length * 2;
      for (const pack of message.stickerPacks ?? []) payloadBytes += pack.length * 2;
      break;
    case "ensureLuckSecret":
      payloadBytes = message.day.length * 2;
      break;
    case "joinLog":
    case "deleteJoinLog":
    case "deleteWedMembers":
    case "deleteAiMemory":
    case "forgetAiMemory":
    case "verificationDelete":
    case "temporaryAdBypassWrite":
    case "flush":
    case "readJoinLog":
    case "readBlocklistIdPage":
    case "recoveryReplay":
    case "storageFlushHold":
      break;
    default: {
      // 穷尽性断言：新增 DiskIOOperationMessage 变体时这一行编译失败，必须为它显式定价。
      // 计价是跨线程传输预算与背压的唯一容量单位（见 infra/diskIO/transport.ts），漏掉
      // 的变体只按 DISK_BUSINESS_MESSAGE_BASE_BYTES 计入，队列水位随之失真。
      // 运行期不可达：调用方只对本线程构造的消息记账，不解析外部输入。
      const unhandled: never = message;
      throw new Error(
        "Unsupported Disk I/O operation message type: " +
        String((unhandled as DiskIOOperationMessage).type)
      );
    }
  }
  return Math.min(Number.MAX_SAFE_INTEGER, DISK_BUSINESS_MESSAGE_BASE_BYTES + payloadBytes);
}

/** 代际失效时只把业务事实交给恢复 FIFO，逐请求等待者由宿主拒绝。 */
export function isDiskBusinessMessage(message: DiskIOOperationMessage): message is DiskBusinessMessage {
  switch (message.type) {
    case "diagnosticBatch":
    case "load":
    case "recoveryReplay":
    case "storageFlushHold":
    case "flush":
    case "readIdentityPolicies":
    case "readBlocklistIdPage":
    case "readJoinLog":
    case "ensureLuckSecret":
      return false;
    default:
      return true;
  }
}
