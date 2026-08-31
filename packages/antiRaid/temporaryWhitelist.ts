import type { Chat } from "@grammyjs/types";
import { adDetectConfigReadiness } from "../config/readiness";
import { TEMPORARY_WHITELIST_REQUIRED_DAYS } from
  "../consts/temporaryWhitelist";
import {
  clearTemporaryWhitelistActivity,
  hasActiveTemporaryWhitelistAt,
  recordTemporaryWhitelistActivity,
} from "../infra/identityPolicy/temporaryWhitelist";
import {
  isWhitelisted,
  promoteAdBypassWhitelistMembership,
} from "../infra/identityPolicy/whitelist";
import { logger } from "../infra/logger";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { visibleSenderChat } from "../users/visibleSender";
import { messageIdentityMetadata } from "../users/identityMetadata";
import { postAntiRaid } from "./workerBridge";
import type { AdDetectionMessageContext } from
  "../types/antiRaid/adDetect";
import type { PromoteAdBypassWhitelistResult } from
  "../infra/identityPolicy/whitelist";
import type { RecordedTemporaryWhitelistActivity } from
  "../types/temporaryWhitelist";

/** 广告检测有效群的一条普通发言计入跨群身份累计；服务消息由调用方先行排除。 */
export function recordEligibleTemporaryWhitelistActivity(
  {
    message,
    botId,
    chatState,
    now,
  }: AdDetectionMessageContext
): boolean {
  if (
    chatState.isAdDetectEnabled !== true ||
    !adDetectConfigReadiness().ok ||
    message.is_automatic_forward === true ||
    isBotOwnMessage(message)
  ) return false;

  const senderChat: Chat | undefined = visibleSenderChat(message);
  const senderId: number | undefined = senderChat?.id ?? message.from?.id;
  if (
    senderId === undefined ||
    senderId === botId ||
    senderChat?.id === message.chat.id ||
    isWhitelisted(senderId)
  ) return false;
  const wasActive: boolean = hasActiveTemporaryWhitelistAt(senderId, now);
  const recorded: RecordedTemporaryWhitelistActivity | undefined =
    recordTemporaryWhitelistActivity(senderId, now);
  if (recorded === undefined) return false;
  if (!wasActive && hasActiveTemporaryWhitelistAt(senderId, now)) {
    // 状态边沿才推一次；Worker 重建时这两类非持久状态本来就是空的。
    postAntiRaid({ type: "temporaryWhitelistGranted", identityId: senderId });
  }
  if (
    recorded.activity.tempWhiteCount ===
    TEMPORARY_WHITELIST_REQUIRED_DAYS
  ) {
    const promotion: PromoteAdBypassWhitelistResult =
      promoteAdBypassWhitelistMembership(
        senderId,
        messageIdentityMetadata(message, senderChat)
      );
    const temporaryCleared: boolean = clearTemporaryWhitelistActivity(senderId);
    if (!promotion.queued || !temporaryCleared) {
      logger.error(
        `Failed to queue complete temporary-whitelist promotion for identity ${senderId}; retaining unacknowledged final values for replay.`
      );
    }
  }
  return recorded.queued;
}
