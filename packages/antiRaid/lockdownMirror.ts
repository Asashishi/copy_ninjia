import { logger } from "../infra/logger";
import {
  clearChatStateField,
  getChatStateCache,
  saveChatStateInBackground,
} from "../infra/storage/stateStore";
import { joinVerificationApi } from "../infra/telegram/client";
import { restoreLockdownInvitePermission } from "../infra/telegram/lockdownPermissions";
import { RESTORE_RETRY_MS } from "../consts/antiRaid/lockdown";
import { antiRaidRuntimeState } from "../cache/main/antiRaid/proxy";
import {
  emergencyLockdownRecoveries,
  emergencyLockdownRecoveryRuntime,
  persistedLockdownFingerprints,
} from "../cache/main/antiRaid/lockdownMirror";
import type {
  EmergencyLockdownRecovery,
  LockdownIntentFingerprint,
  PersistedLockdownFingerprint,
} from "../types/antiRaid/internal";
import type { AdoptableLockdown, AdoptLockdownsMessage } from "../types/antiRaid";
import type { LockdownRecord } from "../types/chatState";

/**
 * Anti-Raid 主线程侧的 lockdown 镜像与紧急恢复。
 *
 * ChatState.lockdown 是跨进程恢复的权威记录；本模块只维护落盘指纹、构造
 * Worker adopt 消息，并在 Worker 耗尽重建预算后接管邀请权限恢复。
 */

export function lockdownFingerprint(record: LockdownRecord): PersistedLockdownFingerprint {
  return {
    phase: record.phase,
    intentId: record.intentId,
    announced: record.announced,
  };
}

/**
 * 这条记录是否已按当前恢复语义落盘。比较 phase、intentId 与 announced；倒计时
 * （expiresAt）在私密模式生效期间每来一条越阈值的入群就会刷新一次，把它算进
 * 来只会让「快照没变」永远不成立，理由见
 * types/antiRaid/internal.ts 的 PersistedLockdownFingerprint 说明。
 */
export function lockdownFingerprintMatches(
  record: LockdownRecord,
  fingerprint: PersistedLockdownFingerprint | undefined
): boolean {
  const current: PersistedLockdownFingerprint = lockdownFingerprint(record);
  return fingerprint?.phase === current.phase &&
    fingerprint.intentId === current.intentId &&
    fingerprint.announced === current.announced;
}

function lockdownIntentFingerprint(record: LockdownRecord): LockdownIntentFingerprint {
  return { phase: record.phase, intentId: record.intentId };
}

function lockdownIntentMatches(
  record: LockdownRecord,
  fingerprint: LockdownIntentFingerprint
): boolean {
  return record.phase === fingerprint.phase && record.intentId === fingerprint.intentId;
}

function toAdoptableLockdown(
  chatId: number,
  record: LockdownRecord,
  now: number
): AdoptableLockdown {
  return {
    chatId,
    phase: record.phase,
    intentId: record.intentId,
    originalPermissions: record.originalPermissions,
    announced: record.announced,
    remainingMs: Math.max(0, record.expiresAt - now),
    persisted: lockdownFingerprintMatches(record, persistedLockdownFingerprints.get(chatId)),
  };
}

/** 把仍在生效的私密模式打包成 adopt 消息，并换算各自的真实剩余时长。 */
export function buildAdoptLockdownsMessage(): AdoptLockdownsMessage {
  const lockdowns: AdoptableLockdown[] = [];
  const now: number = Date.now();
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown) {
      lockdowns.push(toAdoptableLockdown(chatId, chatState.lockdown, now));
    }
  }
  return { type: "adopt", lockdowns };
}

/** 用启动时已从 SQLite 恢复的记录播种“已持久化”指纹。 */
export function seedPersistedLockdownFingerprints(): void {
  persistedLockdownFingerprints.clear();
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown !== undefined) {
      persistedLockdownFingerprints.set(chatId, lockdownFingerprint(chatState.lockdown));
    }
  }
}

function finishEmergencyLockdownRecovery(
  chatId: number,
  recovery: EmergencyLockdownRecovery
): void {
  if (recovery.retryTimer !== null) {
    clearTimeout(recovery.retryTimer);
    recovery.retryTimer = null;
  }
  if (emergencyLockdownRecoveries.get(chatId) === recovery) {
    emergencyLockdownRecoveries.delete(chatId);
  }
}

function runEmergencyLockdownRecovery(
  chatId: number,
  recovery: EmergencyLockdownRecovery
): void {
  if (
    emergencyLockdownRecoveryRuntime.stopped ||
    emergencyLockdownRecoveries.get(chatId) !== recovery ||
    recovery.inFlight !== null
  ) return;

  const task: Promise<void> = (async (): Promise<void> => {
    const before: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
    if (
      before === undefined ||
      !lockdownIntentMatches(before, recovery.fingerprint)
    ) {
      finishEmergencyLockdownRecovery(chatId, recovery);
      return;
    }
    try {
      await restoreLockdownInvitePermission({
        chatId,
        originalPermissions: recovery.originalPermissions,
        api: joinVerificationApi,
      });
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      const current: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
      if (
        current === undefined ||
        !lockdownIntentMatches(current, recovery.fingerprint)
      ) {
        logger.warn(
          `Emergency anti-raid restore for chat ${chatId} completed after its lockdown intent changed; ` +
          "leaving the newer state untouched."
        );
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      persistedLockdownFingerprints.delete(chatId);
      if (clearChatStateField(chatId, "lockdown")) {
        saveChatStateInBackground(chatId, "emergency anti-raid unlock");
        antiRaidRuntimeState.persistenceVersion++;
      }
      logger.log(`Emergency anti-raid permission restore completed for chat ${chatId}.`);
      finishEmergencyLockdownRecovery(chatId, recovery);
    } catch (error: unknown) {
      const current: LockdownRecord | undefined = getChatStateCache().get(chatId)?.lockdown;
      if (
        emergencyLockdownRecoveryRuntime.stopped ||
        current === undefined ||
        !lockdownIntentMatches(current, recovery.fingerprint) ||
        emergencyLockdownRecoveries.get(chatId) !== recovery
      ) {
        finishEmergencyLockdownRecovery(chatId, recovery);
        return;
      }
      logger.error(
        `Emergency anti-raid permission restore failed for chat ${chatId}; ` +
        `retrying in ${RESTORE_RETRY_MS / 1000}s:`,
        error
      );
      recovery.retryTimer = setTimeout((): void => {
        recovery.retryTimer = null;
        runEmergencyLockdownRecovery(chatId, recovery);
      }, RESTORE_RETRY_MS);
      recovery.retryTimer.unref();
    }
  })();
  recovery.inFlight = task;
  void task.finally((): void => {
    if (recovery.inFlight === task) recovery.inFlight = null;
  });
}

function startEmergencyLockdownRecovery(chatId: number, record: LockdownRecord): void {
  const fingerprint: LockdownIntentFingerprint = lockdownIntentFingerprint(record);
  const existing: EmergencyLockdownRecovery | undefined =
    emergencyLockdownRecoveries.get(chatId);
  if (existing !== undefined) {
    if (
      existing.fingerprint.phase === fingerprint.phase &&
      existing.fingerprint.intentId === fingerprint.intentId
    ) return;
    finishEmergencyLockdownRecovery(chatId, existing);
  }
  const recovery: EmergencyLockdownRecovery = {
    fingerprint,
    originalPermissions: { ...record.originalPermissions },
    retryTimer: null,
    inFlight: null,
  };
  emergencyLockdownRecoveries.set(chatId, recovery);
  runEmergencyLockdownRecovery(chatId, recovery);
}

export function stopEmergencyLockdownRecoveries(): void {
  emergencyLockdownRecoveryRuntime.stopped = true;
  for (const recovery of emergencyLockdownRecoveries.values()) {
    if (recovery.retryTimer !== null) {
      clearTimeout(recovery.retryTimer);
      recovery.retryTimer = null;
    }
  }
  // Telegram 请求本身可能永久悬挂，停机不能越过生命周期预算无限等待。
  // 已关闸且清空 owner；迟到的成功/失败都会在 run 中停止，不再修改 state
  // 或重新安排 timer。state 保留 lockdown，下一进程可幂等恢复权限。
  emergencyLockdownRecoveries.clear();
}

/** Worker 自愈放弃后，由主线程独立接管仍挂着的邀请权限恢复。 */
export function recoverAbandonedLockdowns(): void {
  const abandoned: number[] = [];
  for (const [chatId, chatState] of getChatStateCache()) {
    if (chatState.lockdown === undefined) continue;
    abandoned.push(chatId);
    startEmergencyLockdownRecovery(chatId, chatState.lockdown);
  }
  if (abandoned.length === 0) return;
  logger.error(
    "Anti-raid Worker gave up self-healing; main-thread emergency permission recovery started for chats: " +
    abandoned.join(", ")
  );
}
