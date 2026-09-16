import type { Chat } from "grammy/types";
import { adDetectConfigReadiness } from "../config/readiness";
import {
  clearTemporaryAdBypassActivity,
  hasActiveTemporaryAdBypassAt,
  recordTemporaryAdBypassActivity,
} from "../infra/identityPolicy/temporaryAdBypass";
import {
  isWhitelisted,
  promoteAdBypassWhitelistMembership,
} from "../infra/identityPolicy/whitelist";
import { logger } from "../infra/logger";
import { isBotOwnMessage } from "../infra/selfSentTracker";
import { visibleSenderChat } from "../users/visibleSender";
import { messageIdentityMetadata } from "../users/identityMetadata";
import { shouldPromoteToPermanentBypass } from "../states/temporaryAdBypass";
import { postAntiRaid } from "./workerBridge";
import type { AdDetectionMessageContext } from
  "../types/antiRaid/adDetect";
import type { PromoteAdBypassWhitelistResult } from
  "../infra/identityPolicy/whitelist";
import type { RecordedTemporaryAdBypassActivity } from
  "../types/temporaryAdBypass";

/**
 * 广告检测有效群的一条普通发言计入跨群身份累计；服务消息由调用方先行排除。
 * 黑名单身份与黑名单视图冷缺失的身份由 `recordTemporaryAdBypassActivity` 拒绝累计，
 * 不会走到下方的授予边沿与永久晋升。
 */
export function recordEligibleTemporaryAdBypassActivity(
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
  const wasActive: boolean = hasActiveTemporaryAdBypassAt(senderId, now);
  const recorded: RecordedTemporaryAdBypassActivity | undefined =
    recordTemporaryAdBypassActivity(senderId, now);
  if (recorded === undefined) return false;
  if (!wasActive && hasActiveTemporaryAdBypassAt(senderId, now)) {
    // 状态边沿才推一次；Worker 重建时这两类非持久状态本来就是空的。
    postAntiRaid({ type: "temporaryAdBypassGranted", identityId: senderId });
  }
  if (shouldPromoteToPermanentBypass(recorded.activity)) {
    const promotion: PromoteAdBypassWhitelistResult =
      promoteAdBypassWhitelistMembership(
        senderId,
        messageIdentityMetadata(message, senderChat)
      );
    const temporaryCleared: boolean = clearTemporaryAdBypassActivity(senderId);
    if (!promotion.queued || !temporaryCleared) {
      logger.error(
        `Failed to queue complete temporary-whitelist promotion for identity ${senderId}; retaining unacknowledged final values for replay.`
      );
    }
  }
  return recorded.queued;
}
