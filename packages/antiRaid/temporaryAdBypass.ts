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
import { messageIdentityMetadata } from "../users/identityMetadata";
import { shouldPromoteToPermanentBypass } from "../states/temporaryAdBypass";
import { postAntiRaid } from "./workerBridge/controller";
import type { AdDetectionMessageContext } from
  "../types/antiRaid/adDetect";
import type { PromoteAdBypassWhitelistResult } from
  "../infra/identityPolicy/whitelist";
import type { TemporaryAdBypassActivity } from
  "../types/states/temporaryAdBypass";

/**
 * 广告检测有效群的一条普通发言计入跨群身份累计；服务消息由调用方先行排除，前置判定
 * 由调用方经 antiRaid/adCandidate.ts 的 adDetectionSenderId 完成。
 * 黑名单身份与黑名单视图冷缺失的身份由 `recordTemporaryAdBypassActivity` 拒绝累计，
 * 不会走到下方的授予边沿与永久晋升。
 * @returns 本条发言是否计入了累计。
 */
export function recordEligibleTemporaryAdBypassActivity(
  {
    message,
    now,
    senderId,
    senderChat,
  }: AdDetectionMessageContext
): boolean {
  if (isWhitelisted(senderId)) return false;
  const wasActive: boolean = hasActiveTemporaryAdBypassAt(senderId, now);
  const activity: Readonly<TemporaryAdBypassActivity> | undefined =
    recordTemporaryAdBypassActivity(senderId, now);
  if (activity === undefined) return false;
  if (!wasActive && hasActiveTemporaryAdBypassAt(senderId, now)) {
    // 状态边沿才推一次；Worker 重建时这两类非持久状态本来就是空的。
    postAntiRaid({ type: "temporaryAdBypassGranted", identityId: senderId });
  }
  if (shouldPromoteToPermanentBypass(activity)) {
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
  return true;
}
