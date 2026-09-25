/** 热路径场景名到独立领域夹具的唯一注册表。 */

import { createAdCapacityRejectScenario } from "./adDetectScenarios";
import { cooldownScenario } from "./cooldownScenarios";
import { storageFlushScenario } from "./storageFlushScenario";
import { verificationSnapshotScenario } from "./verificationSnapshotScenario";
import { boundedResponseScenario } from "./boundedResponseScenario";
import { wedMemberChatSwitchScenario, wedMemberScenario } from "./wedMemberScenarios";
import { registeredMiddlewareScenario } from "./registeredMiddlewareScenario";
import {
  floodWindowGrowthScenario,
  floodWindowHitScenario,
  floodWindowSteadyScenario,
} from "./floodScenarios";
import {
  createIdentityPermissionReadScenario,
} from "./identityScenarios";
import { createLuckReceiptFastPathScenario } from "./luckReceiptScenario";
import {
  aiMediaDirectTriggerScenario,
  incomingMessageSpineScenario,
  selfSentActiveScenario,
  selfSentEmptyScenario,
} from "./messageSpineScenarios";
import {
  adEmptyMetadataScenario,
  adWireCloneScenario,
  aiActivityLruMissScenario,
  aiActivityScenario,
  boundedRollingBufferScenario,
  chatStateMapReadScenario,
  chatStateReadScenario,
  gagSpeakCounterScenario,
  joinTimestampWindowScenario,
  luckTierTableScenario,
  quotaTimestampWindowScenario,
  redactCleanLogScenario,
  senderMixedIdentityScenario,
  senderScenario,
} from "./scenarios";
import { createTemporaryAdBypassActivityScenario } from
  "./temporaryAdBypassScenario";
import {
  bufferedMessageBuildScenario,
  mentionFactsScenario,
  replyReferenceScenario,
  transcriptRenderScenario,
} from "./transcriptScenarios";
import type { Scenario, ScenarioName } from "./types";
import { base64PayloadScenario, replyAdmissionScenario, replyDeliveryScenario } from "./replyScenarios";
import { proxyTtsDetectScenario, voiceMessageEncodeScenario } from "./voiceScenarios";

/** 按稳定名称建立一份独立场景；每个子进程只调用一次。 */
export function createScenario(name: ScenarioName): Scenario {
  switch (name) {
    case "cooldown-hit": return cooldownScenario("hit");
    case "cooldown-renew": return cooldownScenario("renew");
    case "cooldown-growth": return cooldownScenario("growth");
    case "cooldown-saturated": return cooldownScenario("saturated");
    case "cooldown-expiry": return cooldownScenario("expiry");
    case "reply-admission": return replyAdmissionScenario();
    case "reply-delivery-normal": return replyDeliveryScenario(false);
    case "reply-delivery-capacity": return replyDeliveryScenario(true);
    case "base64-normal": return base64PayloadScenario("normal");
    case "base64-large": return base64PayloadScenario("large");
    case "base64-head": return base64PayloadScenario("head");
    case "base64-tail": return base64PayloadScenario("tail");
    case "voice-message-encode": return voiceMessageEncodeScenario();
    case "proxy-tts-detect": return proxyTtsDetectScenario();
    case "storage-sqlite-flush": return storageFlushScenario();
    case "verification-snapshot": return verificationSnapshotScenario(false);
    case "verification-snapshot-clone": return verificationSnapshotScenario(true);
    case "bounded-response-empty": return boundedResponseScenario("empty");
    case "bounded-response-tiny": return boundedResponseScenario("tiny");
    case "bounded-response-small": return boundedResponseScenario("small");
    case "bounded-response-normal": return boundedResponseScenario("normal");
    case "bounded-response-large": return boundedResponseScenario("large");
    case "wed-member-hit": return wedMemberScenario("hit");
    case "wed-member-growth": return wedMemberScenario("growth");
    case "wed-member-churn": return wedMemberScenario("churn");
    case "wed-member-chat-switch": return wedMemberChatSwitchScenario();
    case "registered-middleware": return registeredMiddlewareScenario();
    case "sender-no-username": return senderScenario();
    case "sender-stable-username": return senderScenario("Stable_User");
    case "sender-mixed-identity": return senderMixedIdentityScenario();
    case "luck-receipt-fast-path": return createLuckReceiptFastPathScenario();
    case "ai-activity-window": return aiActivityScenario();
    case "ai-activity-lru-miss": return aiActivityLruMissScenario();
    case "ad-empty-metadata": return adEmptyMetadataScenario();
    case "ad-wire-clone": return adWireCloneScenario();
    case "ad-capacity-reject": return createAdCapacityRejectScenario();
    case "identity-permission-read": return createIdentityPermissionReadScenario();
    case "temporary-whitelist-activity": return createTemporaryAdBypassActivityScenario();
    case "join-timestamp-window": return joinTimestampWindowScenario();
    case "quota-timestamp-window": return quotaTimestampWindowScenario();
    case "bounded-rolling-buffer": return boundedRollingBufferScenario();
    case "chat-state-read": return chatStateReadScenario();
    case "chat-state-map-read": return chatStateMapReadScenario();
    case "self-sent-empty": return selfSentEmptyScenario();
    case "self-sent-active": return selfSentActiveScenario();
    case "incoming-message-spine": return incomingMessageSpineScenario();
    case "ai-media-direct-trigger": return aiMediaDirectTriggerScenario();
    case "flood-window-hit": return floodWindowHitScenario();
    case "flood-window-growth": return floodWindowGrowthScenario();
    case "flood-window-steady": return floodWindowSteadyScenario();
    case "gag-speak-counter": return gagSpeakCounterScenario();
    case "buffered-message-build": return bufferedMessageBuildScenario();
    case "transcript-render": return transcriptRenderScenario();
    case "reply-reference": return replyReferenceScenario();
    case "mention-facts": return mentionFactsScenario(true);
    case "mention-facts-plain": return mentionFactsScenario(false);
    case "redact-clean-log": return redactCleanLogScenario();
    case "luck-tier-table": return luckTierTableScenario();
  }
}
