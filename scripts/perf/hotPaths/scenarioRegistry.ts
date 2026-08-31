/** 热路径场景名到独立领域夹具的唯一注册表。 */

import { createAdCapacityRejectScenario } from "./adDetectScenarios";
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
  senderScenario,
} from "./scenarios";
import { createTemporaryWhitelistActivityScenario } from
  "./temporaryWhitelistScenario";
import {
  bufferedMessageBuildScenario,
  mentionFactsScenario,
  replyReferenceScenario,
  transcriptRenderScenario,
} from "./transcriptScenarios";
import type { Scenario, ScenarioName } from "./types";

/** 按稳定名称建立一份独立场景；每个子进程只调用一次。 */
export function createScenario(name: ScenarioName): Scenario {
  switch (name) {
    case "sender-no-username": return senderScenario();
    case "sender-stable-username": return senderScenario("Stable_User");
    case "luck-receipt-fast-path": return createLuckReceiptFastPathScenario();
    case "ai-activity-window": return aiActivityScenario();
    case "ai-activity-lru-miss": return aiActivityLruMissScenario();
    case "ad-empty-metadata": return adEmptyMetadataScenario();
    case "ad-wire-clone": return adWireCloneScenario();
    case "ad-capacity-reject": return createAdCapacityRejectScenario();
    case "identity-permission-read": return createIdentityPermissionReadScenario();
    case "temporary-whitelist-activity": return createTemporaryWhitelistActivityScenario();
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
