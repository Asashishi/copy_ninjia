import { chatIsSupergroupById } from "../../cache/main/antiRaid/chatKind";
import { antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
} from "../../cache/main/antiRaid/verificationMirror";
import { BOT_ATMOSPHERE } from "../../config/bot";
import { adDetectAgentConfigSnapshot } from "../../config/agent";
import { getAdSampleConfig } from "../../config/adSamples";
import { adDetectConfigReadiness } from "../../config/readiness";
import { logger } from "../../infra/logger";
import { projectBotActionPermissions } from "../../libs/chatMember";
import {
  getChatState,
  getChatStateCache,
} from "../../infra/storage/stateStore";
import type {
  AdoptVerificationsMessage,
  AntiRaidWorkerMessage,
} from "../../types/antiRaid/protocol";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../../types/antiRaid/verification";
import type { BotChatPermissions } from "../../types/telegram";
import { deleteDeferredVerificationsForChat } from "../verificationAttempts";

/** 提升主线程代理代际；Worker 重生与进程冷启动共用同一入口。 */
export function nextAntiRaidGeneration(): number {
  antiRaidRuntimeState.generation++;
  return antiRaidRuntimeState.generation;
}

/** 构建当前代际的验证接管快照，不把等待延迟落盘的记录重复列入活动集合。 */
export function buildAdoptVerificationsMessage(
  generation: number,
  resumePersistedTerminals: boolean = false
): AdoptVerificationsMessage {
  const verifications: VerificationSnapshot[] = [];
  for (const [key, record] of activeVerificationSnapshots) {
    if (!pendingVerificationDeferrals.has(key)) verifications.push(record);
  }
  const deferredVerifications: DeferredVerificationRecord[] = [
    ...deferredVerificationRecords.values(),
    ...pendingVerificationDeferrals.values(),
  ];
  return {
    type: "adoptVerifications",
    generation,
    verifications,
    deferredVerifications,
    resumePersistedTerminals,
  };
}

/** 把主线程当前生效的广告检测配置投给 Worker；重建时排在新 Worker 的业务消息之前。 */
export function replayAdDetectAgentConfig(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  return postTo({
    type: "agentConfig",
    defaultAtmosphere: BOT_ATMOSPHERE,
    adDetect: adDetectAgentConfigSnapshot(),
    adSamples: adDetectConfigReadiness().ok ? getAdSampleConfig() : null,
  });
}

/** 把机器人权限快照整表交给新 Worker；从未确证的群保持无条目。 */
export function replayBotPermissions(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  for (const [chatId, chatState] of getChatStateCache()) {
    const permissions: BotChatPermissions | undefined = chatState.botPermissions;
    if (permissions === undefined) continue;
    if (!postTo({
      type: "botPermissionsChanged",
      chatId,
      permissions: projectBotActionPermissions(permissions),
    })) return false;
  }
  return true;
}

/** 把主线程已观测到的群类型整表交给新 Worker。 */
export function replayChatKinds(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  for (const [chatId, isSupergroup] of chatIsSupergroupById) {
    if (!postTo({ type: "chatKind", chatId, isSupergroup })) return false;
  }
  return true;
}

/** 人设风格在接管验证和私密模式之前全量重放；新 Worker 无条目即使用默认风格。 */
export function replayChatAtmospheres(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  for (const [chatId, state] of getChatStateCache()) {
    if (state.aiPersona !== undefined && !postTo({ type: "atmosphere", chatId, plain: true })) return false;
  }
  return true;
}

/**
 * adopt 完成后清理开关已关群的残留入群守卫。
 *
 * 必须让 Worker 先接管再发 deactivate，使其按原 revision 协议产生 tombstone；
 * 只在重放前过滤会让旧记录继续留在持久化文件中。
 */
export function purgeDisabledJoinGuards(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): void {
  const purged: Set<number> = new Set();
  for (const record of activeVerificationSnapshots.values()) {
    if (purged.has(record.chatId)) continue;
    if (getChatState(record.chatId).isAntiRaidEnabled === true) continue;
    purged.add(record.chatId);
  }
  for (const record of deferredVerificationRecords.values()) {
    if (purged.has(record.chatId)) continue;
    if (getChatState(record.chatId).isAntiRaidEnabled === true) continue;
    purged.add(record.chatId);
  }
  for (const [chatId, chatState] of getChatStateCache()) {
    if (purged.has(chatId) || chatState.lockdown === undefined) continue;
    if (chatState.isAntiRaidEnabled === true) continue;
    purged.add(chatId);
  }
  if (purged.size === 0) return;
  for (const chatId of purged) {
    deleteDeferredVerificationsForChat(chatId);
    if (postTo({ type: "deactivateJoinGuard", chatId })) continue;
    logger.error(
      `Anti-Raid Worker rejected the join guard cleanup for chat ${chatId}; ` +
      "relying on the next respawn to retry it."
    );
    return;
  }
  logger.log(
    `Cleared join guard runtime left over in ${purged.size} chat(s) whose /antiraid switch is off: ` +
    `${[...purged].join(", ")}.`
  );
}
