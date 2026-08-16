import {
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  queuedLockdownPersistence,
} from "../../cache/main/antiRaid/lockdownMirror";
import { antiRaidBarrier, antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import { LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS } from "../../consts/antiRaid/protocol";
import { settleBlockedRemoval } from "../../infra/blocklist/sweep";
import { logger } from "../../infra/logger";
import {
  clearChatStateField,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
  saveChatStateInBackground,
} from "../../infra/storage/stateStore";
import type {
  AntiRaidWorkerEvent,
  AntiRaidWorkerMessage,
} from "../../types/antiRaid";
import type { PersistedLockdownFingerprint } from "../../types/antiRaid/internal";
import type { LockdownRecord } from "../../types/chatState";
import { handleAdDetected } from "../adDetect";
import {
  lockdownFingerprint,
  lockdownFingerprintMatches,
} from "../lockdownMirror";
import {
  acceptVerificationDelete,
  acceptVerificationUpsert,
} from "../verificationMirror";
import { acceptVerificationDeferred } from "../verificationAttempts";

/**
 * 把群当前的 lockdown 意图写入 SQLite，落定后回执给 Worker。
 *
 * 指纹排除高频 expiresAt；对账轮次仅在恢复语义真正推进时重跑。期间收到的新
 * 事件通过 queued 集合在当前微任务结束后续跑，避免丢掉最后一次唤醒。
 */
function persistCurrentLockdown(
  chatId: number,
  postToWorker: (message: AntiRaidWorkerMessage) => void
): void {
  if (pendingLockdownPersistence.has(chatId)) {
    queuedLockdownPersistence.add(chatId);
    return;
  }
  pendingLockdownPersistence.add(chatId);
  void (async (): Promise<void> => {
    for (
      let round: number = 0;
      round < LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS;
      round++
    ) {
      queuedLockdownPersistence.delete(chatId);
      const expected: LockdownRecord | undefined =
        getChatStateCache().get(chatId)?.lockdown;
      if (expected === undefined) return;
      const expectedFingerprint: PersistedLockdownFingerprint =
        lockdownFingerprint(expected);
      await persistChatState(chatId, "anti-raid lockdown intent");
      const current: LockdownRecord | undefined =
        getChatStateCache().get(chatId)?.lockdown;
      if (current === undefined) return;
      if (!lockdownFingerprintMatches(current, expectedFingerprint)) continue;
      persistedLockdownFingerprints.set(chatId, expectedFingerprint);
      postToWorker({
        type: "lockdownPersisted",
        chatId,
        phase: expectedFingerprint.phase,
        intentId: expectedFingerprint.intentId,
      });
      return;
    }
    logger.error(
      `Anti-raid lockdown intent for chat ${chatId} kept changing across ` +
      `${LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS} durability rounds; ` +
      "yielding before retrying the latest intent."
    );
  })()
    .catch((error: unknown): void => {
      logger.error(
        `Failed to persist anti-raid lockdown intent for chat ${chatId}:`,
        error
      );
    })
    .finally((): void => {
      pendingLockdownPersistence.delete(chatId);
      const rerun: boolean = queuedLockdownPersistence.delete(chatId);
      if (rerun && antiRaidRuntimeState.initialized) {
        queueMicrotask(
          (): void => persistCurrentLockdown(chatId, postToWorker)
        );
      }
    });
}

/** 把 Worker 业务事件归并到主线程镜像、持久化边界或 Telegram 行为入口。 */
export function handleAntiRaidWorkerEvent(
  event: AntiRaidWorkerEvent,
  postToWorker: (message: AntiRaidWorkerMessage) => void
): void {
  switch (event.type) {
    case "lockdown": {
      const expected: LockdownRecord = {
        phase: event.phase,
        intentId: event.intentId,
        originalPermissions: event.originalPermissions,
        announced: event.announced,
        expiresAt: event.expiresAt,
      };
      getOrCreateChatState(event.chatId).lockdown = expected;
      persistedLockdownFingerprints.delete(event.chatId);
      persistCurrentLockdown(event.chatId, postToWorker);
      antiRaidRuntimeState.persistenceVersion++;
      break;
    }
    case "unlock": {
      persistedLockdownFingerprints.delete(event.chatId);
      if (clearChatStateField(event.chatId, "lockdown")) {
        saveChatStateInBackground(event.chatId, "anti-raid unlock");
        antiRaidRuntimeState.persistenceVersion++;
      }
      break;
    }
    case "verificationUpsert":
      if (acceptVerificationUpsert(event)) antiRaidRuntimeState.persistenceVersion++;
      break;
    case "verificationDelete":
      if (acceptVerificationDelete(event)) antiRaidRuntimeState.persistenceVersion++;
      break;
    case "verificationDeferred":
      if (acceptVerificationDeferred(event)) antiRaidRuntimeState.persistenceVersion++;
      break;
    case "blockedMembersRemoved":
      settleBlockedRemoval(event);
      break;
    case "adDetected":
      handleAdDetected(event);
      break;
    case "barrierComplete":
      antiRaidBarrier.settle(event.barrierId, "flushed");
      break;
    case "drainComplete":
      antiRaidBarrier.settle(event.drainId, "flushed");
      break;
  }
}
