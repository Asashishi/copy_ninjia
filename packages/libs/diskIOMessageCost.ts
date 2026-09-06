import { DISK_BUSINESS_MESSAGE_BASE_BYTES } from "../consts/diskIO/business";
import type { DiskIOOperationMessage, DiskBusinessMessage } from "../types/diskIO/messages";
import { jsonSerializedBytes } from "./jsonBytes";

/** 队列中字符串与消息对象的保守成本；高频固定字段不重新序列化。 */
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
    case "verificationUpsert":
    case "diagnosticBatch":
      payloadBytes = jsonSerializedBytes(message) * 2;
      break;
    case "load":
      for (const pack of message.stickerPacks ?? []) payloadBytes += pack.length * 2;
      break;
    case "ensureLuckSecret":
      payloadBytes = message.day.length * 2;
      break;
    case "joinLog":
    case "deleteAiMemory":
    case "forgetAiMemory":
    case "verificationDelete":
    case "temporaryWhitelistWrite":
    case "flush":
    case "readJoinLog":
    case "readBlocklistIdPage":
    case "recoveryReplay":
      break;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, DISK_BUSINESS_MESSAGE_BASE_BYTES + payloadBytes);
}

/** 代际失效时只把业务事实交给恢复 FIFO，逐请求等待者由宿主拒绝。 */
export function isDiskBusinessMessage(message: DiskIOOperationMessage): message is DiskBusinessMessage {
  switch (message.type) {
    case "diagnosticBatch":
    case "load":
    case "recoveryReplay":
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
