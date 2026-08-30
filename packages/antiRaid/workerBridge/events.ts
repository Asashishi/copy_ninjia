import {
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  queuedLockdownPersistence,
} from "../../cache/main/antiRaid/lockdownMirror";
import { antiRaidBarrier, antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import { LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS } from "../../consts/antiRaid/protocol";
import { assertPersistableLockdown } from "../../database/codec/chatState";
import { settleBlockedRemoval } from "../../infra/blocklist/sweep";
import { logger } from "../../infra/logger";
import {
  clearChatStateField,
  getChatStateCache,
  getOrCreateChatState,
  persistChatState,
  saveChatStateInBackground,
} from "../../infra/storage/stateStore";
import type { AntiRaidWorkerEvent } from "../../types/antiRaid/events";
import type { AntiRaidWorkerMessage } from
  "../../types/antiRaid/protocol";
import type { PersistedLockdownFingerprint } from "../../types/antiRaid/internal";
import type { LockdownRecord } from "../../types/chatState";
import { handleAdDetected, handleAdVerdictTrue } from "../adDetect";
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
 * 指纹排除 expiresAt（理由见 types/antiRaid/internal.ts）；对账轮次仅在恢复语义
 * 真正推进时重跑。期间收到的新事件通过 queued 集合在当前微任务结束后续跑，
 * 避免丢掉最后一次唤醒。
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
      try {
        await persistChatState(chatId, "anti-raid lockdown intent");
      } catch (error: unknown) {
        logger.error(
          `Failed to persist anti-raid lockdown intent for chat ${chatId}:`,
          error
        );
        abandonLockdownPersistence(chatId, expectedFingerprint, postToWorker);
        return;
      }
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
        `Anti-raid lockdown durability loop for chat ${chatId} failed:`,
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

/**
 * 这一轮意图确定落不了盘：清掉内存与磁盘上的记录，并通知 Worker fail-safe 打开。
 *
 * 内存里那条记录必须清掉——它写不进 SQLite，留着会让本群此后每一次状态写入
 * 一起失败。磁盘上那条同样要删：留着它，下次进程启动会 adopt 出一个没人在
 * 恢复的私密模式，把新进群的人继续踢掉。真正的权限恢复由 Worker 收到
 * lockdownPersistFailed 后立刻发起（见 states/lockdown.ts 的 persistFailed）。
 */
function abandonLockdownPersistence(
  chatId: number,
  fingerprint: PersistedLockdownFingerprint,
  postToWorker: (message: AntiRaidWorkerMessage) => void
): void {
  const current: LockdownRecord | undefined =
    getChatStateCache().get(chatId)?.lockdown;
  if (current !== undefined && lockdownFingerprintMatches(current, fingerprint)) {
    persistedLockdownFingerprints.delete(chatId);
    if (clearChatStateField(chatId, "lockdown")) {
      saveChatStateInBackground(chatId, "anti-raid lockdown persist failure");
      antiRaidRuntimeState.persistenceVersion++;
    }
  }
  postToWorker({
    type: "lockdownPersistFailed",
    chatId,
    phase: fingerprint.phase,
    intentId: fingerprint.intentId,
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
        announcementMessageId: event.announcementMessageId,
        expiresAt: event.expiresAt,
      };
      try {
        assertPersistableLockdown(expected, `chat state ${event.chatId}`);
      } catch (error: unknown) {
        // 绝不让它进内存：ChatState 先写内存再落盘，挂上一条落盘自检过不了的
        // 记录，会让该群此后每一条状态写入（任何开关命令）都跟着抛。
        logger.error(
          `Anti-raid lockdown intent for chat ${event.chatId} cannot be persisted; abandoning it:`,
          error
        );
        postToWorker({
          type: "lockdownPersistFailed",
          chatId: event.chatId,
          phase: event.phase,
          intentId: event.intentId,
        });
        break;
      }
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
    case "adVerdictTrue":
      handleAdVerdictTrue(event);
      break;
    case "barrierComplete":
      antiRaidBarrier.settle(event.barrierId, "flushed");
      break;
    case "drainComplete":
      antiRaidBarrier.settle(event.drainId, "flushed");
      break;
  }
}
